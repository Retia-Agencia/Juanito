// dashboard/server/queries.js
// Capa de LECTURA del dashboard. Todo es SELECT — en F1 el dashboard es read-only
// (garantía 4 de docs/DASHBOARD-ROADMAP.md: primero ves el dato, después el botón).
//
// Reusa `src/db/index.js` en vez de reimplementar: abre su propia conexión al MISMO
// archivo SQLite (WAL + busy_timeout), y hereda las ~122 funciones ya probadas.
// Lo que no tiene función exportada se consulta con el `db` por defecto.
//
// Ojo con las zonas horarias, que en este esquema NO son uniformes:
//   · calendly_pushes.due_at / call_start   → UTC  (comparables con datetime('now'))
//   · call_outcomes.call_start / asked_at   → UTC
//   · pending_replies.created_at            → UTC  (CURRENT_TIMESTAMP)
//   · reminders.due_at                      → LOCAL (ver localNow() en src/db/index.js)
//   · scheduled_messages.time_hm            → LOCAL

import db, {
  listAuthorizedGroups,
  listApprovalGroups,
  listGroupPersonas,
  listScheduledMessages,
  listActiveOutreach,
  listPendingTasks,
  listBusinessContext,
  listProposedBusinessFacts,
  listPendingReplies,
  listHeldPendingReplies,
  listDraftsForDate,
  listOptins,
  listCloserPauses,
  isCalendlyPaused,
  isCloserPaused,
  isDmApprovalOn,
  getOutcomesInWindow,
  getScheduledCallsInWindow,
  getDueCalendlyPushes,
} from '../../src/db/index.js';

import { PROGRAMS, COMPANIES, PROGRAM_LABELS } from '../../src/calendly/programs.js';
import { ACCOUNTS } from '../../src/calendly/accounts.js';
import { SKIP_ALERTABLES, ETIQUETA_SKIP } from '../../src/calendly/skip-reasons.js';
import { CLOSERS, IGNORED_CLOSERS, workLidForCloser, extraJidsForCloser } from '../../src/calendly/closers.js';

const TZ = () => process.env.TZ || 'America/Bogota';
const REPLY_TTL_MIN = Number(process.env.REPLY_APPROVAL_TTL_MIN || 30);

// Fecha/hora local en el mismo formato que usa src/db/index.js, para poder comparar
// contra las columnas que guardan hora local.
function localNow() {
  return new Date().toLocaleString('sv', { timeZone: TZ() });
}
const localDate = () => localNow().slice(0, 10);

// Ventana UTC [desde, hasta] en el formato 'YYYY-MM-DD HH:MM:SS' del esquema.
function utcOffset(hours) {
  return new Date(Date.now() + hours * 3600000).toISOString().slice(0, 19).replace('T', ' ');
}

const q = (sql, ...args) => db.prepare(sql).all(...args);
const q1 = (sql, ...args) => db.prepare(sql).get(...args);

// ─── Salud ────────────────────────────────────────────────────────────────────
//
// Cada check devuelve { key, label, level, count, detail, rows }. `level` es
// 'ok' | 'warn' | 'error' y es lo que el watchdog usa para decidir si alerta.

// El push que no sale (§18.AV). Es LA razón por la que existe este dashboard: el dato
// estuvo en la DB desde el primer día y nadie lo miró.
export function pushesVencidos(graceMin = 15) {
  const rows = q(
    `SELECT id, event_uuid, push_n, program, closer_email, prospect_name,
            call_start, due_at, status
       FROM calendly_pushes
      WHERE status = 'scheduled'
        AND due_at < datetime('now', ?)
      ORDER BY due_at ASC
      LIMIT 100`,
    `-${graceMin} minutes`
  );
  return {
    key: 'pushes_vencidos',
    label: 'Pushes vencidos sin enviar',
    level: rows.length ? 'error' : 'ok',
    count: rows.length,
    detail: rows.length
      ? `${rows.length} push(es) con due_at vencido hace más de ${graceMin} min y todavía en 'scheduled'`
      : 'Ninguno pendiente fuera de plazo',
    rows,
  };
}

// Pushes que se quedaron en 'sending': alguien los reclamó (claimCalendlyPush) y el
// proceso murió antes de marcarlos. Quedan huérfanos, nadie los reintenta.
export function pushesAtascados(minutos = 10) {
  const rows = q(
    `SELECT id, event_uuid, push_n, closer_email, prospect_name, due_at
       FROM calendly_pushes
      WHERE status = 'sending' AND due_at < datetime('now', ?)
      ORDER BY due_at ASC LIMIT 50`,
    `-${minutos} minutes`
  );
  return {
    key: 'pushes_atascados',
    label: "Pushes atascados en 'sending'",
    level: rows.length ? 'error' : 'ok',
    count: rows.length,
    detail: rows.length
      ? 'Reclamados por un proceso que murió antes de marcarlos. Nadie los reintenta.'
      : 'Ninguno',
    rows,
  };
}

// Motivos de skip. `skip_reason` YA se escribe (slug estable de src/calendly/skip-reasons.js),
// así que para las filas nuevas se lee la columna y se traduce a algo legible. El parseo del
// `message` queda SOLO como fallback de las filas anteriores al cambio, que tienen la columna
// en NULL: borrarlo dejaría en blanco todo el histórico del panel.
//
// Dos sutilezas del fallback que ya costaron un falso positivo:
//  · `.*` inicial es GREEDY a propósito → se queda con el ÚLTIMO ' | skip: ' cuando un
//    push acumuló varios (markCalendlyPushSkipped concatena, no reemplaza).
//  · Hay que mirar SOLO el motivo, nunca el `message` completo: ese campo guarda además
//    el copy de WhatsApp, donde frases como "sin teléfono" aparecen de forma legítima.
export function motivoDeSkip(message, skipReason = null) {
  const slug = String(skipReason || '').trim();
  if (slug) return ETIQUETA_SKIP[slug] || slug;
  const m = /.*\|\s*skip:\s*(.+)$/s.exec(String(message || ''));
  return m ? m[1].trim() : 'sin motivo registrado';
}

export function motivosDeSkip(dias = 7) {
  const rows = q(
    `SELECT message, skip_reason, COUNT(*) AS n
       FROM calendly_pushes
      WHERE status = 'skipped' AND created_at > datetime('now', ?)
      GROUP BY message, skip_reason`,
    `-${dias} days`
  );
  const agg = new Map();
  for (const r of rows) {
    // Varios motivos llevan el uuid de la cita incrustado ("la cita entró por Calendly
    // como <uuid>"). Sin colapsarlos, cada cita es su propia categoría y el panel es
    // ruido en vez de señal.
    const motivo = motivoDeSkip(r.message, r.skip_reason).replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '<uuid>'
    );
    agg.set(motivo, (agg.get(motivo) || 0) + r.n);
  }
  const lista = [...agg.entries()]
    .map(([motivo, n]) => ({ motivo, n }))
    .sort((a, b) => b.n - a.n);
  return {
    key: 'motivos_skip',
    label: `Motivos de skip (${dias}d)`,
    level: 'ok',
    count: lista.reduce((s, x) => s + x.n, 0),
    detail: 'Por `skip_reason`; las filas viejas (columna en NULL) caen al texto de `message`',
    rows: lista,
  };
}

// Pushes que NO salieron por falta de configuración, no por una razón legítima.
//
// Un skip por 'cita canceled' o 'rescheduled' es el sistema haciendo su trabajo. Un skip
// 'sin-optin', 'sin-hilo' u 'obsoleto' es un push que el closer debía recibir y no recibió.
// Misma clasificación que usa la alerta del bot (SKIP_ALERTABLES), a propósito: si el panel
// y la alerta contaran distinto, uno de los dos estaría mintiendo.
//
// El regex queda para las filas viejas sin slug — mismo motivo que en motivoDeSkip.
const SKIPS_QUE_IMPORTAN = /sin opt-in|sin hilo establecido|contact_jid|sin mapear|sin teléfono/i;

export function pushesNoEntregados(horas = 24) {
  const filas = q(
    `SELECT id, event_uuid, push_n, program, closer_email, prospect_name, call_start,
            message, skip_reason
       FROM calendly_pushes
      WHERE status = 'skipped' AND created_at > datetime('now', ?)`,
    `-${horas} hours`
  );
  const rows = filas
    .map(({ message, skip_reason, ...r }) => ({
      ...r,
      slug: String(skip_reason || '').trim(),
      motivo: motivoDeSkip(message, skip_reason),
    }))
    .filter((r) => (r.slug ? SKIP_ALERTABLES.has(r.slug) : SKIPS_QUE_IMPORTAN.test(r.motivo)))
    .map(({ slug, ...r }) => r);
  return {
    key: 'pushes_no_entregados',
    label: `Pushes no entregados por configuración (${horas}h)`,
    level: rows.length ? 'error' : 'ok',
    count: rows.length,
    detail: rows.length
      ? 'El closer debía recibirlos y no llegaron: falta opt-in, hilo o mapeo'
      : 'Todos los skips del período fueron legítimos (cancelada, reagendada, obsoleta)',
    rows,
  };
}

// Respuestas pendientes pasadas del TTL. El cron las expira, pero si el cron no corre
// se acumulan acá y es la señal.
export function respuestasVencidas() {
  const rows = q(
    `SELECT id, group_name, kind, trigger_sender, created_at
       FROM pending_replies
      WHERE status = 'pending' AND held = 0
        AND created_at < datetime('now', ?)
      ORDER BY created_at ASC LIMIT 50`,
    `-${REPLY_TTL_MIN} minutes`
  );
  return {
    key: 'respuestas_vencidas',
    label: 'Respuestas pendientes pasadas del TTL',
    level: rows.length ? 'warn' : 'ok',
    count: rows.length,
    detail: `TTL configurado: ${REPLY_TTL_MIN} min`,
    rows,
  };
}

// Outcomes que se preguntaron y nadie contestó.
export function outcomesSinRespuesta(horas = 2) {
  const rows = q(
    `SELECT id, closer_name, closer_email, lead_name, call_start, asked_at, status
       FROM call_outcomes
      WHERE status = 'pending' AND asked_at IS NOT NULL
        AND asked_at < datetime('now', ?)
      ORDER BY asked_at ASC LIMIT 50`,
    `-${horas} hours`
  );
  return {
    key: 'outcomes_sin_respuesta',
    label: `Outcomes preguntados sin responder (>${horas}h)`,
    level: rows.length ? 'warn' : 'ok',
    count: rows.length,
    detail: rows.length ? 'El closer no contestó el Push 4' : 'Ninguno',
    rows,
  };
}

// Reagendas donde se pidió la fecha y quedó colgado.
export function reagendasColgadas() {
  const rows = q(
    `SELECT id, closer_name, lead_name, call_start, reschedule_asked, prompted_at
       FROM call_outcomes
      WHERE status = 'awaiting_date'
      ORDER BY call_start ASC LIMIT 50`
  );
  return {
    key: 'reagendas_colgadas',
    label: 'Reagendas esperando fecha',
    level: rows.length > 5 ? 'warn' : 'ok',
    count: rows.length,
    detail: 'Se preguntó la fecha nueva y no llegó',
    rows,
  };
}

// Recordatorios fallidos. Incluye las alertas del propio watchdog que no salieron:
// si esto tiene filas, el canal de aviso está roto y hay que mirar el dashboard.
export function recordatoriosFallidos(dias = 3) {
  const rows = q(
    `SELECT id, text, due_at, to_phone, to_group_name, attempts
       FROM reminders
      WHERE status = 'failed' AND due_at > ?
      ORDER BY due_at DESC LIMIT 50`,
    new Date(Date.now() - dias * 86400000).toLocaleString('sv', { timeZone: TZ() })
  );
  return {
    key: 'recordatorios_fallidos',
    label: `Recordatorios fallidos (${dias}d)`,
    level: rows.length ? 'error' : 'ok',
    count: rows.length,
    detail: rows.length
      ? 'Incluye las alertas del watchdog que no se pudieron entregar'
      : 'Ninguno',
    rows,
  };
}

// Mensajes recurrentes que debían publicarse hoy y no se publicaron.
export function programadosSinPublicar() {
  const hoy = localDate();
  const dow = String(new Date().toLocaleString('en-US', { timeZone: TZ(), weekday: 'short' }));
  const idx = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[dow.slice(0, 3)];
  const ahoraHm = localNow().slice(11, 16);

  const rows = listScheduledMessages({ activeOnly: true }).filter((m) => {
    const dias = String(m.days || '').split(',').map((d) => d.trim());
    if (!dias.includes(String(idx))) return false;
    if (String(m.time_hm) > ahoraHm) return false; // todavía no le toca
    return m.last_sent_date !== hoy;
  });

  return {
    key: 'programados_sin_publicar',
    label: 'Mensajes recurrentes vencidos hoy',
    level: rows.length ? 'warn' : 'ok',
    count: rows.length,
    detail: rows.length
      ? 'Les tocaba hoy, ya pasó su hora y last_sent_date no es hoy'
      : 'Todos al día',
    rows,
  };
}

// Frescura: cuánto hace que se escribió en cada tabla viva. Un silencio largo en
// `messages` significa que Baileys no está recibiendo nada.
export function frescura() {
  const tablas = [
    ['messages', 'created_at'],
    ['calendly_pushes', 'created_at'],
    ['call_outcomes', 'created_at'],
    ['pending_replies', 'created_at'],
  ];
  const rows = tablas.map(([t, col]) => {
    const r = q1(
      `SELECT MAX(${col}) AS ultimo,
              CAST((julianday('now') - julianday(MAX(${col}))) * 24 * 60 AS INTEGER) AS min_hace
         FROM ${t}`
    );
    return { tabla: t, ultimo: r?.ultimo || null, minutos: r?.min_hace ?? null };
  });
  const mensajes = rows.find((r) => r.tabla === 'messages');
  const mudo = mensajes?.minutos != null && mensajes.minutos > 180;
  return {
    key: 'frescura',
    label: 'Frescura por tabla',
    level: mudo ? 'warn' : 'ok',
    count: rows.length,
    detail: mudo
      ? `Sin mensajes nuevos hace ${mensajes.minutos} min — puede ser normal de madrugada`
      : 'Escrituras recientes en todas las tablas vivas',
    rows,
  };
}

// Interruptores globales. No es una falla, pero un `calendly_paused` olvidado en '1'
// es exactamente el tipo de cosa que deja una semana sin pushes.
export function interruptores() {
  const pausados = listCloserPauses();
  const calendlyOff = isCalendlyPaused();
  return {
    key: 'interruptores',
    label: 'Interruptores',
    level: calendlyOff ? 'warn' : 'ok',
    count: pausados.length + (calendlyOff ? 1 : 0),
    detail: calendlyOff
      ? 'Calendly está PAUSADO globalmente'
      : `Calendly activo · ${pausados.length} closer(s) pausado(s)`,
    rows: [
      { clave: 'calendly_paused', valor: calendlyOff ? 'SÍ' : 'no' },
      { clave: 'dm_approval', valor: isDmApprovalOn() ? 'SÍ' : 'no' },
      ...pausados.map((p) => ({ clave: `pausa: ${p.email ?? p.key ?? ''}`, valor: 'SÍ' })),
    ],
  };
}

export function salud() {
  const checks = [
    pushesVencidos(),
    pushesAtascados(),
    pushesNoEntregados(),
    respuestasVencidas(),
    outcomesSinRespuesta(),
    reagendasColgadas(),
    recordatoriosFallidos(),
    programadosSinPublicar(),
    frescura(),
    interruptores(),
    motivosDeSkip(),
  ];
  const peor = checks.some((c) => c.level === 'error')
    ? 'error'
    : checks.some((c) => c.level === 'warn')
      ? 'warn'
      : 'ok';
  return { nivel: peor, generadoAt: new Date().toISOString(), checks };
}

// ─── Listados por tab (solo lectura) ──────────────────────────────────────────

export const aprobaciones = () => ({
  drafts: listDraftsForDate(localDate()),
  respuestas: listPendingReplies(),
  retenidas: listHeldPendingReplies(),
});

export function grupos() {
  const personas = Object.fromEntries(listGroupPersonas().map((p) => [p.group_id, p.persona]));
  const conAprobacion = new Set(listApprovalGroups().map((g) => g.group_id));
  return listAuthorizedGroups().map((g) => ({
    ...g,
    persona: personas[g.group_id] || null,
    requiere_aprobacion: conAprobacion.has(g.group_id) || !!g.require_approval,
  }));
}

export const programados = () => listScheduledMessages({ activeOnly: false });
export const outreach = () => listActiveOutreach();
export const tareas = () => listPendingTasks();
export const negocio = () => ({
  activos: listBusinessContext(),
  propuestos: listProposedBusinessFacts(),
});

export const recordatorios = () =>
  q(`SELECT id, text, due_at, to_phone, to_group_name, created_by, status, attempts
       FROM reminders
      WHERE status IN ('pending','failed')
      ORDER BY due_at ASC LIMIT 200`);

export const calls = () => ({
  agenda: getScheduledCallsInWindow(utcOffset(-2), utcOffset(24)),
  outcomes: getOutcomesInWindow(utcOffset(-24), utcOffset(0)),
  porEnviar: getDueCalendlyPushes(),
});

export const optins = () => {
  const todos = listOptins();
  return {
    total: todos.length,
    ganados: todos.filter((o) => o.source === 'self').length,
    sembrados: todos.filter((o) => o.source !== 'self').length,
    filas: todos,
  };
};

// Interruptores, con una fila por closer para poder pausarlo desde la UI (F2).
// Misma fuente de verdad que `/calendly` por WhatsApp: la tabla `settings`. La pausa es
// por IDENTIDAD (email), no por persona: una con dos conexiones se pausa por separado
// — ver la invariante en src/calendly/closers.js.
export const toggles = () => ({
  calendlyPausado: isCalendlyPaused(),
  dmAprobacion: isDmApprovalOn(),
  closers: Object.entries(CLOSERS).map(([email, c]) => ({
    email,
    nombre: c.name,
    conexion: c.account || '30x',
    pausado: isCloserPaused(email),
  })),
});

// Registries desde el CÓDIGO (fuente de verdad hoy). Editables desde la UI hasta F3.
//
// ⚠️ ACCOUNTS trae getters de token: nunca serializar `token()`. Solo si existe.
export function registries() {
  return {
    fuente: 'código (src/calendly/*.js) — la escritura llega en F3',
    empresas: COMPANIES,
    programas: Object.values(PROGRAMS).map((p) => ({
      key: p.key,
      label: p.label,
      company: p.company,
      companyLabel: COMPANIES[p.company] || p.company,
      connection: p.connection,
      eventType: p.eventType,
      titleHints: p.titleHints || [],
      pitch: p.pitch || null,
      materials: p.materials || null,
      active: p.active !== false,
    })),
    // ⚠️ `token()`, `dryRun()` y `push4()` leen `process.env` DEL PROCESO QUE LLAMA, y este
    // proceso es el dashboard, no el bot. `docker-compose.yml` pasa las env EXPLÍCITAMENTE por
    // servicio y a `dash` no le pasa ninguna de Calendly (no las necesita: nunca llama a la API).
    // Llamarlas acá devolvía los DEFAULTS del contenedor del dashboard y los mostraba como si
    // fueran la configuración del bot. Medido el 2026-07-30: el tab decía `tieneToken: no` y
    // `dryRun: sí` en las DOS conexiones, mientras el `.env` tiene el token puesto y
    // `CALENDLY_DRY_RUN=false` — o sea reportaba MUDO justo lo que está enviando de verdad.
    // Exactamente la clase de dato falso que este dashboard existe para eliminar.
    // Se devuelven en null (la tabla los pinta "—"). Verlos de verdad exige preguntarle al
    // proceso del bot: es el control server de F6. Lo que NO depende del entorno (orgUri con su
    // default hardcodeado, hubspot, sheets, eventTypes) sí es fiable y se sigue mostrando.
    conexiones: Object.values(ACCOUNTS).map((a) => ({
      key: a.key,
      label: a.label,
      tieneToken: null,                  // nunca el valor, y ahora tampoco una adivinanza
      orgUri: a.orgUri(),
      dryRun: null,
      push4: null,
      hubspot: !!a.hubspot,
      sheets: a.sheets || null,
      eventTypes: a.eventTypes,
    })),
    // `workLid` sale de workLidForCloser y NO de un find sobre CLOSER_LIDS: desde que ese mapa
    // incluye también los aparatos secundarios (`extraJids`), el find podía devolver el LID
    // SECUNDARIO y este panel mostraría como "hilo de trabajo" el que no lo es.
    closers: Object.entries(CLOSERS).map(([email, c]) => ({
      email,
      name: c.name,
      phone: c.phone,
      connection: c.account || '30x',
      workLid: workLidForCloser(email)?.split('@')[0] || null,
      extraJids: extraJidsForCloser(email),
    })),
    // Los emails que el poll salta EN SILENCIO. Vivían enterrados en un archivo fuente;
    // acá quedan a la vista para auditarlos. Un host retirado y uno que factura calls
    // todos los días se ven igual desde el bot — ese fue exactamente el bug §18.AV.
    ignorados: [...IGNORED_CLOSERS],
    etiquetasPrograma: PROGRAM_LABELS,
  };
}
