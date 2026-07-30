// dashboard/server/actions.js
// Capa de ESCRITURA del dashboard (F2 de docs/DASHBOARD-ROADMAP.md).
//
// Tres reglas que definen este archivo:
//
//  1. **Cero SQL nuevo.** Cada acción llama a una función ya exportada por
//     `src/db/index.js` — las mismas que usan los comandos de WhatsApp y las tools.
//     Si acá hubiera un UPDATE propio, el dashboard y el bot podrían divergir, que es
//     exactamente la clase de bug que este proyecto existe para cazar.
//  2. **Cero regla de negocio duplicada.** Donde la validación vive en el bot y es
//     gorda (armar un outreach: resolver contacto, validar teléfono, piso de
//     intervalo, calcular next_due_at), el dashboard NO la reimplementa: expone solo
//     lo que puede validar honesto. Ver la nota de `outreach` más abajo.
//  3. **Apagado por default, tab por tab.** `DASH_WRITES` es una lista de tabs
//     (`aprobaciones,toggles`) o `todo`. Vacío = dashboard de solo lectura, o sea el
//     comportamiento de F1. Es el kill switch de la fase.
//
// `sale: true` marca las acciones cuyo efecto termina en un mensaje de WhatsApp a un
// humano. El servidor las reporta a la UI para que pida confirmación explícita antes
// de disparar (mismo criterio que el roadmap fija para el chat de F6).

import sqlite, {
  approveDraft,
  reviseDraft,
  discardDraft,
  approvePendingReply,
  revisePendingReply,
  discardPendingReply,
  setGroupApproval,
  setGroupPersona,
  deleteGroupPersona,
  listAuthorizedGroups,
  createScheduledMessage,
  cancelScheduledMessage,
  finishOutreach,
  getTask,
  setTaskStatus,
  setBusinessFactStatus,
  saveReminder,
  cancelReminder,
  snoozeReminder,
  setCalendlyPaused,
  setCloserPaused,
  setDmApproval,
} from '../../src/db/index.js';

// Quién firma las escrituras del dashboard en las columnas de auditoría
// (`decided_by`, `updated_by`, `created_by`). Que se distinga de un LID de WhatsApp
// es el punto: dentro de un mes hay que poder saber si un draft lo aprobó el jefe por
// DM o alguien desde la consola.
const AUTOR = 'dashboard';

// ─── Interruptor por tab ──────────────────────────────────────────────────────

export function tabsHabilitados() {
  const raw = (process.env.DASH_WRITES || '').trim();
  if (!raw) return [];
  if (raw === 'todo') return Object.keys(ACCIONES);
  const pedidos = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return pedidos.filter((t) => t in ACCIONES);
}

export const habilitado = (tab) => tabsHabilitados().includes(tab);

// ─── Validación (frontera de confianza) ───────────────────────────────────────
//
// El dashboard vive en un tailnet de dos personas y no tiene login: la red es la
// auth. Eso cubre "quién entra", no "qué manda" — un fetch mal armado desde la propia
// UI llega igual. Todo lo que cruza el HTTP se valida acá.

export class MalaPeticion extends Error {}
const mal = (msg) => {
  throw new MalaPeticion(msg);
};

const entero = (v, campo) => (Number.isInteger(v) && v > 0 ? v : mal(`${campo}: se esperaba un id entero`));

const texto = (v, campo, max = 4000) => {
  if (typeof v !== 'string') mal(`${campo}: se esperaba texto`);
  const s = v.trim();
  if (!s) mal(`${campo}: no puede ir vacío`);
  if (s.length > max) mal(`${campo}: excede ${max} caracteres`);
  return s;
};

const textoOpcional = (v, campo, max = 4000) => (v == null || v === '' ? null : texto(v, campo, max));

const bandera = (v, campo) => (typeof v === 'boolean' ? v : mal(`${campo}: se esperaba true o false`));

const unoDe = (v, campo, ops) => (ops.includes(v) ? v : mal(`${campo}: debe ser uno de ${ops.join(' | ')}`));

// Hora local en 24h, mismo formato que `scheduled_messages.time_hm`.
const horaHm = (v, campo) =>
  /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : mal(`${campo}: usá HH:MM en 24h`);

// Sello de hora LOCAL 'YYYY-MM-DD HH:MM:SS', como guarda `reminders.due_at`
// (ojo: en este esquema las zonas horarias NO son uniformes — ver queries.js).
const selloLocal = (v, campo) =>
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(v || ''))
    ? String(v)
    : mal(`${campo}: usá 'YYYY-MM-DD HH:MM:SS' en hora local`);

// Días de la semana como los guarda el esquema: CSV de 0(domingo)-6.
function diasCsv(v, campo) {
  const partes = (Array.isArray(v) ? v : String(v || '').split(',')).map((d) => String(d).trim());
  const nums = partes.map((d) => (/^[0-6]$/.test(d) ? Number(d) : mal(`${campo}: días como CSV de 0(dom) a 6`)));
  if (!nums.length) mal(`${campo}: hace falta al menos un día`);
  return [...new Set(nums)].sort().join(',');
}

// Default-deny, igual que el bot: si Juanito no está autorizado en ese grupo, desde el
// dashboard tampoco se le programa nada. Devuelve el nombre para no perderlo.
function grupoAutorizado(v) {
  const id = texto(v, 'grupoId', 80);
  const g = listAuthorizedGroups().find((x) => x.group_id === id);
  if (!g) mal(`el grupo ${id} no está autorizado — habilitalo con /grupo on por WhatsApp`);
  return { id, nombre: g.group_name || id };
}

// ─── Acciones, tab por tab ────────────────────────────────────────────────────
//
// Cada acción devuelve un número: filas afectadas, o el id nuevo si crea algo. 0
// significa "no aplicó" (la fila ya cambió de estado), y la UI lo dice tal cual en vez
// de mentir con un éxito.

export const ACCIONES = {
  // Reemplaza /aprobaciones y /respuestas.
  aprobaciones: {
    // Aprobar publica en el grupo: lo recoge el cron de group-messages.
    'draft.aprobar': { sale: true, fn: (b) => approveDraft(entero(b.id, 'id')) },
    'draft.corregir': {
      fn: (b) => reviseDraft(entero(b.id, 'id'), texto(b.texto, 'texto'), textoOpcional(b.feedback, 'feedback', 500)),
    },
    'draft.descartar': { fn: (b) => discardDraft(entero(b.id, 'id')) },

    'respuesta.aprobar': { sale: true, fn: (b) => approvePendingReply(entero(b.id, 'id')) },
    'respuesta.corregir': {
      fn: (b) =>
        revisePendingReply(entero(b.id, 'id'), texto(b.texto, 'texto'), textoOpcional(b.feedback, 'feedback', 500)),
    },
    'respuesta.descartar': { fn: (b) => discardPendingReply(entero(b.id, 'id')) },
  },

  // Reemplaza /confirmaciones grupo y /persona.
  //
  // `deauthorizeGroup` NO se expone: en el bot va con leaveGroup() y acá no hay socket,
  // así que dejaría al grupo desautorizado con Juanito adentro. Salir de un grupo sigue
  // siendo un acto deliberado por WhatsApp (decisión del roadmap).
  grupos: {
    // setGroupApproval es un UPDATE sobre authorized_groups → un grupo no autorizado
    // devuelve 0 cambios solo. El default-deny sale gratis.
    aprobacion: { fn: (b) => setGroupApproval(texto(b.grupoId, 'grupoId', 80), bandera(b.activo, 'activo')) },
    persona: {
      fn: (b) => {
        const g = grupoAutorizado(b.grupoId);
        setGroupPersona({ groupId: g.id, groupName: g.nombre, persona: texto(b.persona, 'persona', 2000), updatedBy: AUTOR });
        return 1;
      },
    },
    'persona.borrar': { fn: (b) => deleteGroupPersona(texto(b.grupoId, 'grupoId', 80)) },
  },

  // Reemplaza /programados.
  programados: {
    // Crear un recurrente es programar mensajes reales a un grupo: `sale`.
    // `brief` → mensaje GENERADO (Claude redacta y el jefe aprueba antes de publicar);
    // `texto` → mensaje FIJO que se publica literal. Uno u otro, nunca los dos.
    crear: {
      sale: true,
      fn: (b) => {
        const g = grupoAutorizado(b.grupoId);
        const brief = textoOpcional(b.brief, 'brief', 2000);
        const cuerpo = textoOpcional(b.texto, 'texto');
        if (!!brief === !!cuerpo) mal('mandá `brief` (mensaje generado) o `texto` (mensaje fijo), no ambos');
        return createScheduledMessage({
          groupId: g.id,
          groupName: g.nombre,
          days: diasCsv(b.dias, 'dias'),
          timeHm: horaHm(b.hora, 'hora'),
          text: cuerpo || '',
          createdBy: AUTOR,
          kind: brief ? 'generated' : 'fixed',
          brief,
        });
      },
    },
    cancelar: { fn: (b) => cancelScheduledMessage(entero(b.id, 'id')) },
  },

  // Solo CANCELAR, no crear.
  //
  // Armar un outreach en el bot son ~80 líneas de reglas: resolver el contacto por
  // nombre o número, validar el teléfono, respetar el piso de intervalo anti-spam,
  // calcular la parada por default y el next_due_at, y resolver de parte de quién va
  // (§18.Y). Reimplementarlas acá las pone en dos lugares que van a divergir, y estos
  // mensajes salen a terceros que no son del equipo. Crear sigue siendo por DM;
  // apagar uno que se está portando mal es lo urgente y eso sí está.
  outreach: {
    cancelar: { fn: (b) => finishOutreach(entero(b.id, 'id'), 'cancelled') },
  },

  // Reemplaza /tareas. Dos acciones y no un `estado` genérico porque no son simétricas:
  // cerrar una tarea le avisa al que la pidió, descartarla no.
  tareas: {
    hecha: { sale: true, fn: (b) => cerrarTarea(entero(b.id, 'id')) },
    descartar: { fn: (b) => setTaskStatus(entero(b.id, 'id'), 'dismissed', AUTOR) },
  },

  // Reemplaza /negocio. 'active' entra al prompt del bot, 'archived' lo olvida.
  negocio: {
    estado: {
      fn: (b) =>
        setBusinessFactStatus(entero(b.id, 'id'), unoDe(b.estado, 'estado', ['active', 'archived']), AUTOR),
    },
  },

  // Reemplaza la tool manage_reminders. El texto sale por la cola anti-ban del bot:
  // el dashboard solo inserta la fila (mismo outbox que usa el watchdog).
  recordatorios: {
    crear: {
      sale: true,
      fn: (b) =>
        Number(
          saveReminder({
            text: texto(b.texto, 'texto', 3000),
            dueAt: selloLocal(b.cuando, 'cuando'),
            toPhone: textoOpcional(b.telefono, 'telefono', 60),
            createdBy: AUTOR,
          }).lastInsertRowid
        ),
    },
    // cancelReminder y snoozeReminder están scopeadas por created_by a propósito: por
    // WhatsApp nadie puede tocar los recordatorios de otra persona. El dashboard es
    // consola de admin y sí puede, así que le pasamos el created_by de la propia fila.
    // No es un bypass accidental — es la misma decisión que "la red es la auth".
    cancelar: { fn: (b) => cancelReminder(entero(b.id, 'id'), dueñoDeRecordatorio(b.id)) },
    posponer: {
      fn: (b) => snoozeReminder(entero(b.id, 'id'), selloLocal(b.cuando, 'cuando'), dueñoDeRecordatorio(b.id)),
    },
  },

  // Reemplaza /calendly on|off y /confirmaciones dm. Misma fuente de verdad que el
  // comando de WhatsApp (tabla `settings`), así que se ven idénticos desde los dos lados.
  toggles: {
    calendly: {
      fn: (b) => {
        setCalendlyPaused(bandera(b.pausado, 'pausado'));
        return 1;
      },
    },
    closer: { fn: (b) => setCloserPaused(texto(b.email, 'email', 120), bandera(b.pausado, 'pausado')) },
    dm: {
      fn: (b) => {
        setDmApproval(bandera(b.activo, 'activo'));
        return 1;
      },
    },
  },
};

// Cerrar una tarea Y avisarle al que la pidió, igual que `/tareas hecha` en
// [src/bot/commands.js]. Sin este aviso, una tarea cerrada desde el dashboard se cierra
// EN SILENCIO para el jefe: la misma clase de agujero que este proyecto existe para
// tapar, solo que del otro lado.
//
// El dashboard no tiene socket, así que el aviso sale por el outbox de `reminders` (el
// cron del bot lo despacha en el próximo minuto por la cola anti-ban). Ese job prefija
// el texto con "⏰ Recordatorio: ", así que el mensaje llega como
// "⏰ Recordatorio: ✅ Listo lo que pediste: …" — se lee bien y no vale un cambio en el bot.
function cerrarTarea(id) {
  const t = getTask(id);
  if (!t) mal(`la tarea ${id} no existe`);
  const cambios = setTaskStatus(id, 'done', AUTOR);
  if (cambios && t.created_by) {
    saveReminder({
      text: `✅ Listo lo que pediste: ${t.request}`,
      dueAt: new Date().toLocaleString('sv', { timeZone: process.env.TZ || 'America/Bogota' }),
      toPhone: t.created_by,
      createdBy: AUTOR,
    });
  }
  return cambios;
}

// `created_by` real de un recordatorio pendiente. NULL es un valor legítimo en filas
// viejas y en ese caso el scope por igualdad nunca matchea, así que lo decimos claro en
// vez de devolver un 0 cambios que parece un bug de la UI.
function dueñoDeRecordatorio(id) {
  const row = sqlite
    .prepare(`SELECT created_by FROM reminders WHERE id = ? AND status = 'pending'`)
    .get(entero(id, 'id'));
  if (!row) mal(`el recordatorio ${id} no existe o ya no está pendiente`);
  if (row.created_by == null) mal(`el recordatorio ${id} no tiene created_by: solo se puede tocar por WhatsApp`);
  return row.created_by;
}

// ─── Despacho ─────────────────────────────────────────────────────────────────

export function ejecutar(tab, accion, cuerpo) {
  const grupo = ACCIONES[tab];
  if (!grupo) mal(`tab desconocido: ${tab}`);
  if (!habilitado(tab)) {
    mal(`las escrituras de "${tab}" están apagadas — agregalo a DASH_WRITES y recreá el contenedor dash`);
  }
  const def = grupo[accion];
  if (!def) mal(`acción desconocida: ${tab}/${accion}`);
  const n = def.fn(cuerpo && typeof cuerpo === 'object' ? cuerpo : {});
  return { ok: n > 0, n };
}

// Contrato que la UI necesita para dibujarse: qué puede escribir y qué pide confirmación.
export function catalogo() {
  return Object.fromEntries(
    tabsHabilitados().map((tab) => [
      tab,
      Object.fromEntries(Object.entries(ACCIONES[tab]).map(([a, d]) => [a, { sale: !!d.sale }])),
    ])
  );
}
