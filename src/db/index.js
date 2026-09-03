// src/db/index.js
// Funciones de acceso a SQLite — importar desde cualquier módulo.
// Estas firmas son el "Contrato" que consume el Track B.

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { normalizePhone } from '../common/utils.js';
import { decidePushAction } from '../calendly/push-logic.js';
// Identidad de una call (§18.AU). Son helpers PUROS y viven allá, pegados al `isSameLead` que
// ya decidía si dos pushes hablan del mismo lead — duplicar esa regla acá sería el bug siguiente.
import { dedupeSameCall, isSameLead, sourceRankOf } from '../calendly/reschedule-logic.js';

const DB_PATH = process.env.DB_PATH || './data/brain.sqlite';
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
// El dashboard abre este mismo archivo desde otro proceso (docs/DASHBOARD-ROADMAP.md). Sin
// busy_timeout, un escritor que encuentra la DB ocupada recibe SQLITE_BUSY al instante en vez
// de esperar. WAL ya permite lectores concurrentes; esto cubre el cruce de dos escritores.
db.pragma('busy_timeout = 5000');

// Ventana en la que un outcome a medio flujo sigue "caliente" y se lleva la respuesta
// del closer (ver getActiveOutcomeForCloser). Pasada, cae al final de la fila.
const REPLY_WINDOW_MIN = Number(process.env.OUTCOME_REPLY_WINDOW_MIN || 120);

// ─── Mensajes / historial ─────────────────────────────────────────────────────

export function saveMessage({ role, content, source = 'bot', chatId = null }) {
  return db
    .prepare(`INSERT INTO messages (role, content, source, chat_id) VALUES (?, ?, ?, ?)`)
    .run(role, content, source, chatId);
}

// Últimos N mensajes como historial para Claude (orden cronológico).
// Si se pasa chatId, se filtra a ESE hilo: aísla el historial de cada grupo y de
// los DMs del jefe entre sí (evita que datos de un DM privado se filtren a un grupo).
// Sin chatId mantiene el comportamiento anterior (todos los hilos 'bot').
// `sinceMinutes` (opcional): ventana de TIEMPO — solo turnos de los últimos N minutos.
// `limit` sigue siendo el tope DURO de mensajes (palanca anti-tokens en grupos con alto
// flujo). created_at es UTC (CURRENT_TIMESTAMP) → la ventana compara 100% en UTC.
export function getRecentHistory(limit = 20, chatId = null, sinceMinutes = null) {
  const mins = Number(sinceMinutes);
  const hasWindow = sinceMinutes != null && Number.isFinite(mins) && mins > 0;
  const windowClause = hasWindow ? `AND created_at >= datetime('now', ?)` : '';
  const windowArg = hasWindow ? [`-${mins} minutes`] : [];

  if (chatId) {
    return db
      .prepare(`
        SELECT role, content FROM messages
        WHERE source = 'bot' AND chat_id = ? ${windowClause}
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(chatId, ...windowArg, limit)
      .reverse();
  }
  return db
    .prepare(`
      SELECT role, content FROM messages
      WHERE source = 'bot' ${windowClause}
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(...windowArg, limit)
    .reverse();
}

// Búsqueda de texto en el historial (para "¿qué acordamos la semana pasada?")
export function searchMessages(query, sinceDays = 90) {
  return db
    .prepare(`
      SELECT role, content, created_at FROM messages
      WHERE content LIKE ?
        AND created_at >= datetime('now', '-' || ? || ' days')
      ORDER BY created_at DESC
      LIMIT 30
    `)
    .all(`%${query}%`, sinceDays);
}

// ─── Recordatorios ───────────────────────────────────────────────────────────

export function saveReminder({
  text,
  dueAt,
  toPhone = null,
  toGroup = null,
  toGroupName = null,
  createdBy = null,
}) {
  return db
    .prepare(`
      INSERT INTO reminders (text, due_at, to_phone, to_group_id, to_group_name, created_by, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `)
    .run(text, dueAt, toPhone, toGroup, toGroupName, createdBy);
}

// Hora local como string YYYY-MM-DD HH:MM:SS comparable con due_at.
// SQLite 'localtime' falla en Alpine (sin tzdata), así que usamos JS Date.
function localNow(offsetHours = 0) {
  return new Date(Date.now() + offsetHours * 3600000).toLocaleString('sv', {
    timeZone: process.env.TZ || 'America/Bogota',
  });
}

// `next_attempt_at` es el freno del reintento (ver `registrarFalloRecordatorio`): mientras esté
// en el futuro la fila sigue 'pending' pero este job no la toca. NULL = nunca falló.
export function getPendingReminders() {
  return db
    .prepare(`
      SELECT * FROM reminders
      WHERE status = 'pending'
        AND due_at <= ?
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY due_at ASC
    `)
    .all(localNow(), localNow());
}

export function markReminderSent(id) {
  return db
    .prepare(`
      UPDATE reminders
      SET status = 'sent', sent_at = datetime('now'), sent = 1
      WHERE id = ?
    `)
    .run(id);
}

// Mata el recordatorio de una. Se conserva para un fallo que YA se sabe definitivo (no hay
// destinatario posible); el camino normal del scheduler es `registrarFalloRecordatorio`.
export function markReminderFailed(id) {
  return db.prepare(`UPDATE reminders SET status = 'failed' WHERE id = ?`).run(id);
}

// Incrementa el contador de intentos y devuelve el nuevo valor (uso interno del scheduler)
export function incrementReminderAttempt(id) {
  db.prepare(`UPDATE reminders SET attempts = attempts + 1 WHERE id = ?`).run(id);
  return db.prepare(`SELECT attempts FROM reminders WHERE id = ?`).get(id)?.attempts ?? 0;
}

// ── Fallo de entrega de un recordatorio: reintentar antes de rendirse ─────────
// La columna `attempts` existía desde el primer día y NADIE la leía: el scheduler marcaba
// 'failed' ante CUALQUIER error, así que un hipo de la cola de WhatsApp —o un
// `bossDmTarget()` que todavía no resolvió en el arranque— mataba el recordatorio para
// siempre, y nadie se entera de un recordatorio que no llegó.
//
// Ahora el fallo es transitorio por defecto: la fila sigue 'pending' y se posterga con
// backoff. Recién al agotar los intentos queda 'failed'. El techo importa: sin él, un
// destinatario inválido se reintentaría cada minuto para siempre.
export const MAX_INTENTOS_RECORDATORIO = 5;

// Espera en minutos ANTES del intento n+1 (el último valor se repite si sobran intentos).
// Total ~23 min de ventana, que cubre de sobra una reconexión de Baileys sin que el
// recordatorio llegue tan tarde que ya no sirva.
const ESPERA_REINTENTO_MIN = [1, 2, 5, 15];

export function registrarFalloRecordatorio(id) {
  const intentos = incrementReminderAttempt(id);
  if (intentos >= MAX_INTENTOS_RECORDATORIO) {
    db.prepare(`UPDATE reminders SET status = 'failed' WHERE id = ?`).run(id);
    return { intentos, agotado: true, esperaMin: 0 };
  }
  const esperaMin = ESPERA_REINTENTO_MIN[Math.min(intentos - 1, ESPERA_REINTENTO_MIN.length - 1)];
  db.prepare(`UPDATE reminders SET next_attempt_at = ? WHERE id = ?`).run(localNow(esperaMin / 60), id);
  return { intentos, agotado: false, esperaMin };
}

export function getUpcomingReminders(hours = 24) {
  return db
    .prepare(`
      SELECT * FROM reminders
      WHERE status = 'pending' AND due_at > ? AND due_at <= ?
      ORDER BY due_at ASC
    `)
    .all(localNow(), localNow(hours));
}

// ── Gestión de recordatorios por el jefe (tool manage_reminders) ──────────────
// Scope SIEMPRE por created_by: el solicitante solo ve/toca lo que él agendó
// (aislamiento — no puede listar ni cancelar recordatorios de otra persona).

// Lista los pendientes de un creador, ordenados por fecha. Incluye los ya vencidos
// que aún no se enviaron (útil para "¿qué tengo pendiente?").
export function listReminders(createdBy) {
  return db
    .prepare(`
      SELECT id, text, due_at, to_phone, to_group_id, to_group_name FROM reminders
      WHERE status = 'pending' AND created_by = ?
      ORDER BY due_at ASC
    `)
    .all(createdBy);
}

// Cancela un recordatorio propio y pendiente. status='cancelled' (no DELETE) =
// reversible y el scheduler (que solo lee 'pending') lo ignora automáticamente.
export function cancelReminder(id, createdBy) {
  return db
    .prepare(`
      UPDATE reminders SET status = 'cancelled'
      WHERE id = ? AND created_by = ? AND status = 'pending'
    `)
    .run(id, createdBy).changes;
}

// Reprograma un recordatorio propio y pendiente (sigue pending, nueva due_at).
export function snoozeReminder(id, newDueAt, createdBy) {
  return db
    .prepare(`
      UPDATE reminders SET due_at = ?
      WHERE id = ? AND created_by = ? AND status = 'pending'
    `)
    .run(newDueAt, id, createdBy).changes;
}

// ─── Resúmenes de chats/grupos ────────────────────────────────────────────────

export function saveSummary({ chatId, chatName, summary, periodStart = null, periodEnd = null }) {
  return db
    .prepare(`
      INSERT INTO group_context (group_id, group_name, summary, period_start, period_end)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(chatId, chatName || chatId, summary, periodStart, periodEnd);
}

export function getRecentSummaries(limit = 10) {
  return db
    .prepare(`
      SELECT group_id AS chat_id, group_name AS chat_name, summary,
             period_start, period_end, created_at
      FROM group_context
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(limit);
}

export function searchSummaries(query) {
  return db
    .prepare(`
      SELECT group_id AS chat_id, group_name AS chat_name, summary, created_at
      FROM group_context
      WHERE summary LIKE ? OR group_name LIKE ?
      ORDER BY created_at DESC
      LIMIT 20
    `)
    .all(`%${query}%`, `%${query}%`);
}

// Alias legacy (los usan archivos del Track B hasta que refactoricen)
export function saveGroupContext({ groupId, groupName, summary, rawSnippet }) {
  return db
    .prepare(`
      INSERT INTO group_context (group_id, group_name, summary, raw_snippet)
      VALUES (?, ?, ?, ?)
    `)
    .run(groupId, groupName || groupId, summary, rawSnippet || null);
}

export function getRecentGroupContext(limit = 10) {
  return db
    .prepare(`
      SELECT group_name, summary, created_at FROM group_context
      ORDER BY created_at DESC LIMIT ?
    `)
    .all(limit);
}

// ─── Memoria de largo plazo ───────────────────────────────────────────────────

// owner_lid = null → memoria del SISTEMA (núcleo, compartida; la escribe un admin con
// save_memory y alimenta el comportamiento del bot para todos). owner_lid = <LID> → memoria
// PERSONAL de ese contacto (remember_note): solo se carga cuando ESE mismo LID está hablando.
// Aísla la memoria del jefe de la de cada admin (§18 1B) — antes era global y se filtraba.
export function setMemory(key, value, ownerLid = null) {
  return db
    .prepare(`
      INSERT INTO memory (key, value, owner_lid, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value, owner_lid = excluded.owner_lid, updated_at = CURRENT_TIMESTAMP
    `)
    .run(key, value, ownerLid);
}

export function getMemory(key) {
  return db.prepare(`SELECT value FROM memory WHERE key = ?`).get(key)?.value;
}

// Devuelve la memoria del SISTEMA (owner_lid IS NULL) MÁS la PERSONAL del LID dado. Sin ownerLid
// (grupos/desconocidos) devuelve solo la del sistema — nunca las notas personales de nadie.
export function getAllMemory(ownerLid = null) {
  return db
    .prepare(`SELECT key, value, owner_lid FROM memory WHERE owner_lid IS NULL OR owner_lid = ?`)
    .all(ownerLid);
}

export function searchMemory(query, ownerLid = null) {
  return db
    .prepare(`
      SELECT key, value, updated_at FROM memory
      WHERE (key LIKE ? OR value LIKE ?)
        AND (owner_lid IS NULL OR owner_lid = ?)
      ORDER BY updated_at DESC
      LIMIT 20
    `)
    .all(`%${query}%`, `%${query}%`, ownerLid);
}

// ¿Existe ya un hilo de DM con este JID? Es el guard ANTI-BAN para las notificaciones a
// terceros (§18.AD): Juanito nunca escribe en frío a quien no le ha escrito antes — ese es
// el patrón que dispara los softbans. Un DM atendido queda persistido en `messages` con
// chat_id = el JID del interlocutor, así que su presencia prueba que el hilo existe.
export function hasDmThread(jid) {
  if (!jid) return false;
  const row = db
    .prepare(`SELECT 1 FROM messages WHERE chat_id = ? AND source != 'group' LIMIT 1`)
    .get(jid);
  return !!row;
}

// ─── Deduplicación de webhooks ────────────────────────────────────────────────
// Devuelve true si el mensaje es nuevo (y lo marca), false si ya se procesó.
//
// ⚠️ El `catch` es DELIBERADAMENTE angosto. `false` acá significa "ya lo procesamos, descartalo":
// todos los callers cortan el flujo con eso, así que tragarse cualquier error y devolver `false`
// convierte un problema transitorio de la DB en un mensaje del jefe/closer que se pierde sin una
// sola línea de log. Y no es hipotético: `agent` y `dash` escriben el MISMO archivo SQLite desde
// dos procesos, o sea SQLITE_BUSY es un resultado esperable, no una rareza.
//
// La única excepción que de verdad prueba "ya existía" es la violación de la PRIMARY KEY. Todo lo
// demás se loguea y se relanza: `onMessage` está envuelto en un `.catch()` que lo registra
// (src/whatsapp/index.js), así que el mensaje igual se descarta — pero A GRITOS y no en silencio,
// que es la diferencia entre un bug de un día y el mes de ceguera de §18.AY.
const YA_EXISTIA = new Set(['SQLITE_CONSTRAINT_PRIMARYKEY', 'SQLITE_CONSTRAINT_UNIQUE']);

export function markIfNew(messageId) {
  if (!messageId) return true; // sin ID no podemos deduplicar, dejamos pasar
  try {
    db.prepare(`INSERT INTO processed_messages (message_id) VALUES (?)`).run(messageId);
    return true;
  } catch (err) {
    if (YA_EXISTIA.has(err?.code)) return false;
    console.error(`[DB] markIfNew(${messageId}) falló con ${err?.code || 'error sin código'}: ${err?.message}`);
    throw err;
  }
}

// Consulta SIN consumir: ¿ya se marcó esta clave? `markIfNew` no sirve para preguntar porque
// preguntar CON él ya gasta la marca. Lo usa el aviso de pagos de Stripe, que ahora deduplica
// por (pago, destinatario) y necesita mirar también la clave vieja por-pago antes de decidir.
export function yaProcesado(messageId) {
  if (!messageId) return false;
  return !!db.prepare(`SELECT 1 FROM processed_messages WHERE message_id = ?`).get(messageId);
}

// ─── Calendly: pushes precall (dedup + agenda de Push 3) ──────────────────────
// Devuelve 'new' | 'rescheduled' | 'unchanged'. La DECISIÓN de qué hacer vive en
// el módulo puro src/calendly/push-logic.js (testeable sin DB); aquí solo se hace
// el CRUD. `reschedule` con `resetFromSent` re-arma un push ya enviado cuando la
// cita se reagendó a una hora futura (bug #2).

export function scheduleCalendlyPush(p) {
  const existing = db
    .prepare(`SELECT id, status, call_start FROM calendly_pushes WHERE event_uuid = ? AND push_n = ?`)
    .get(p.event_uuid, p.push_n);

  const { action, resetFromSent } = decidePushAction({ existing, incoming: p, nowMs: Date.now() });

  // `program` (§18.AB) es opcional: los pushes 0/3 pueden no traerlo. Normalizamos a
  // null para que el binding de named params no falle.
  const row = { program: null, ...p };

  if (action === 'insert') {
    db.prepare(`
      INSERT INTO calendly_pushes
        (event_uuid, push_n, program, closer_email, closer_phone, prospect_name,
         prospect_phone, call_start, due_at, message)
      VALUES
        (@event_uuid, @push_n, @program, @closer_email, @closer_phone, @prospect_name,
         @prospect_phone, @call_start, @due_at, @message)
    `).run(row);
    return 'new';
  }

  if (action === 'reschedule') {
    // Si la fila ya estaba 'sent', volverla a 'scheduled' y limpiar sent_at para
    // que el cron la vuelva a entregar a la nueva hora.
    const statusClause = resetFromSent ? `, status = 'scheduled', sent_at = NULL` : '';
    db.prepare(`
      UPDATE calendly_pushes
      SET program = @program, closer_email = @closer_email, closer_phone = @closer_phone,
          prospect_name = @prospect_name, prospect_phone = @prospect_phone,
          call_start = @call_start, due_at = @due_at, message = @message${statusClause}
      WHERE id = @id
    `).run({ ...row, id: existing.id });
    return 'rescheduled';
  }

  return 'unchanged';
}

export function getDueCalendlyPushes() {
  return db
    .prepare(`
      SELECT * FROM calendly_pushes
      WHERE status = 'scheduled' AND due_at <= datetime('now')
      ORDER BY due_at ASC
    `)
    .all();
}

// Claim atómico (bug #1): toma la fila solo si sigue 'scheduled'. Devuelve true
// si ESTE worker la reclamó (la pasó a 'sending'), false si otro ya la tenía.
export function claimCalendlyPush(id) {
  const info = db
    .prepare(`UPDATE calendly_pushes SET status = 'sending' WHERE id = ? AND status = 'scheduled'`)
    .run(id);
  return info.changes === 1;
}

// Devuelve una fila reclamada ('sending') a 'scheduled' para reintentar (ej. WA caído).
export function revertCalendlyPush(id) {
  return db
    .prepare(`UPDATE calendly_pushes SET status = 'scheduled' WHERE id = ? AND status = 'sending'`)
    .run(id);
}

// Rescata las filas que quedaron RECLAMADAS por un proceso que murió antes de resolverlas.
// `claimCalendlyPush` las pasa a 'sending' y todos los caminos de `runCalendlyDelivery` las
// terminan (sent/skipped) o las revierten… salvo uno: que el proceso se caiga en el medio.
// Ahí la fila queda en 'sending' PARA SIEMPRE, porque `getDueCalendlyPushes` solo mira
// 'scheduled'. Nadie la reintenta y nadie la entierra: el push simplemente no existe más.
//
// 🩸 Medido el 2026-08-26: dos Push 0 muertos así (ids 3455 y 3470), 15 horas en el limbo. El
// dashboard los venía marcando en rojo desde las 00:16 (check `pushes_atascados`), pero el
// canal de WhatsApp de esas alertas estaba apagado, así que nadie se enteró. Y la causa de
// fondo no es rara: el bot se reinicia por cada caída de socket de WhatsApp (razón 428), o
// sea que ESTO pasa cada vez que un push cae dentro de la ventana de un reinicio.
//
// SIN umbral de antigüedad, y es deliberado. El llamador es `runCalendlyDelivery` al ABRIR el
// tick, y ahí no hay ninguna entrega en vuelo: el guard `_delivering` impide dos ticks
// solapados, y el único otro proceso que abre esta DB —el dashboard— jamás escribe en
// `calendly_pushes`. O sea que toda fila en 'sending' en ese instante es huérfana por
// construcción, no por vieja. No hay doble envío que evitar.
//
// Se intentó primero con un umbral de 10 minutos sobre `due_at` (el proxy que usa el check
// `pushesAtascados` del dashboard) y resultó peor que inútil: un Push 3 en catch-up nace con
// `due_at = ahora`, así que la fila huérfana se quedaba 10 minutos más en el limbo… justo los
// minutos que le quedaban antes de que la llamada empezara y el push perdiera sentido.
export function reclaimStuckCalendlyPushes() {
  return db
    .prepare(`UPDATE calendly_pushes SET status = 'scheduled' WHERE status = 'sending'`)
    .run().changes;
}

export function markCalendlyPushSent(id) {
  return db
    .prepare(`UPDATE calendly_pushes SET status = 'sent', sent_at = datetime('now') WHERE id = ?`)
    .run(id);
}

// `reason` es el texto humano que se anexa al `message` (lo que se lee en el dashboard y en
// los logs). `slug` es la clasificación ESTABLE, y es lo que consulta la auditoría: el texto
// cambia con el copy, el slug no. Hasta acá la columna `skip_reason` estaba muerta (194 de 195
// filas en NULL) y todo el mundo terminaba haciendo `message LIKE '%...%'`, que se rompe al
// tocar una palabra. Ver SKIP_SLUGS/SKIP_ALERTABLES en src/calendly/skip-reasons.js.
export function markCalendlyPushSkipped(id, reason = '', slug = null) {
  return db
    .prepare(
      `UPDATE calendly_pushes
          SET status = 'skipped',
              skip_reason = COALESCE(?, skip_reason),
              message = COALESCE(message,'') || ' | skip: ' || ?
        WHERE id = ?`
    )
    .run(slug, reason, id);
}

// Pushes REALMENTE perdidos por closer en las últimas `hours` horas: los que se saltaron por
// una causa que un humano puede arreglar (ver SKIP_ALERTABLES). Cancelaciones, reagendas y
// duplicados NO entran: son operación normal y contarlos volvería la alerta ruido.
//
// Filtra por la columna `skip_reason`, no por el texto de `message`. Consecuencia: las filas
// anteriores a este cambio tienen la columna en NULL y quedan fuera. Es a propósito — la
// auditoría mira hacia adelante y una ventana de 24h las deja atrás sola.
// Agrupa por closer Y POR MOTIVO, no solo por closer. El desglose hace falta porque la
// auditoría descarta los motivos que ya se curaron (un `sin-optin` de esta madrugada cuando el
// closer escribió a media mañana) y con un COUNT(*) agregado no hay forma de restar solo esa
// parte: o se descartaba al closer entero o no se descartaba nada. Quien lo consume vuelve a
// sumar (ver runSkipAudit).
export function getSkipsAlertablesPorCloser(slugs, hours = 24) {
  const lista = [...slugs];
  if (!lista.length) return [];
  return db
    .prepare(`
      SELECT closer_email,
             skip_reason,
             COUNT(*)           AS n,
             MAX(prospect_name) AS ejemplo
        FROM calendly_pushes
       WHERE status = 'skipped'
         AND skip_reason IN (${lista.map(() => '?').join(',')})
         AND call_start >= datetime('now', ?)
       GROUP BY closer_email, skip_reason
       ORDER BY n DESC
    `)
    .all(...lista, `-${Number(hours) || 24} hours`);
}

// ─── Dedup de alertas que SOBREVIVE al reinicio ───────────────────────────────
// `shouldAlert` de health.js vive en memoria a propósito, y su comentario lo defiende: tras un
// reinicio, re-alertar "confirma que un fallo persistente sigue vivo". Eso es cierto para un
// fallo VIVO (un token muerto sigue muerto) y falso para un hecho HISTÓRICO.
//
// 🩸 El 2026-08-26 la auditoría de skips avisó ~9 veces por las MISMAS dos filas de Dana. Nada
// que nadie hiciera podía cambiarlas: la llamada ya había pasado. Lo que repetía el aviso era
// que el bot arrancó nueve veces ese día (cuatro caídas por 428 + los despliegues), y cada
// arranque borraba el dedup. O sea: el ruido escalaba justo cuando el sistema estaba peor, que
// es exactamente cuando menos se necesita.
//
// El dashboard ya resolvía esto bien tres archivos más allá (`yaAvisamos` contra `dash_alerts`).
// Esto es lo mismo sobre `settings`, que ya existe y no necesita migración.
export function shouldAlertPersistent(key, ttlHours = 6, nowMs = Date.now()) {
  const k = `alerta:${key}`;
  const previo = Number(getSetting(k, 0));
  if (previo && nowMs - previo < ttlHours * 3600 * 1000) return false;
  setSetting(k, String(nowMs));
  return true;
}

// ─── Calendly: outcomes post-call (§18.AB) ────────────────────────────────────
// Fuente de verdad del registro de calls: el estado que el closer confirmó por
// WhatsApp tras la llamada (Show/No show/Reagendó + resultado). Una fila por call.

// Crea (o ignora si ya existe) un outcome PENDIENTE: ya se le preguntó al closer y
// se espera su respuesta. event_uuid es único → reintentos del cron no duplican.
// Devuelve 'new' | 'exists'.
export function createPendingOutcome(o) {
  const row = {
    program: null, closer_email: null, closer_phone: null, closer_name: null,
    lead_name: null, lead_phone: null, reminded: 0, ...o,
  };
  // closer_phone NORMALIZADO (igual que el opt-in) — es la clave de matcheo de la
  // respuesta del closer (getActiveOutcomeForCloser normaliza el número entrante).
  row.closer_phone = normalizePhone(row.closer_phone) || null;
  // `reminded`: default 0 (Push 4 clásico → el cron insiste una vez). El modelo nudge
  // (§18.AF) lo crea con reminded=1 para SUPRIMIR el recordatorio (ya mandó un nudge, no
  // debe re-preguntar la pregunta clásica) sin perder la captura de una respuesta de
  // reagenda (getActiveOutcomeForCloser no mira `reminded`).
  const info = db
    .prepare(`
      INSERT OR IGNORE INTO call_outcomes
        (event_uuid, program, closer_email, closer_phone, closer_name,
         lead_name, lead_phone, call_start, status, reminded, asked_at, prompted_at)
      VALUES
        (@event_uuid, @program, @closer_email, @closer_phone, @closer_name,
         @lead_name, @lead_phone, @call_start, 'pending', @reminded, datetime('now'), datetime('now'))
    `)
    .run(row);
  return info.changes === 1 ? 'new' : 'exists';
}

// ── Push 4: marcar enviado y abrir el pendiente, en UNA transacción ──────────
// Antes eran dos llamadas sueltas y en ese orden: el push quedaba 'sent' y RECIÉN después se
// insertaba en `call_outcomes`. Si esa inserción fallaba (SQLITE_BUSY es normal acá: `agent` y
// `dash` escriben el mismo archivo), al closer ya se le había preguntado y su respuesta no
// tenía dónde caer — y el push, ya consumido, no se volvía a mandar. Se preguntaba al vacío.
//
// Ahora o pasan las dos cosas o no pasa ninguna: si la transacción explota, el push sigue
// 'scheduled' y el ciclo siguiente lo reintenta. El costo de esa falla es un Push 4 repetido
// al closer (molesto pero visible); el de la versión anterior era una respuesta perdida en
// silencio, que es el modo de fallo caro.
//
// ⚠️ El `INSERT OR IGNORE` de `createPendingOutcome` sigue siendo el dedup: si la fila ya
// existía, devuelve 'exists' y la transacción igual marca el push. Eso es correcto — el
// pendiente está abierto, que es la única condición que importa.
export const marcarPush4Preguntado = db.transaction((pushId, outcome) => {
  const estado = createPendingOutcome(outcome);
  markCalendlyPushSent(pushId);
  return estado;
});

// Registra un outcome AUTOMÁTICO (sin preguntar): ej. la cita se canceló en Calendly.
// Si ya hay una fila pendiente para esa call, la cierra como 'auto'.
export function recordAutoOutcome(o) {
  const row = {
    program: null,
    closer_email: null,
    closer_phone: null,
    closer_name: null,
    lead_name: null,
    lead_phone: null,
    resultado: null,
    ...o,
  };
  row.closer_phone = normalizePhone(row.closer_phone) || null;
  return db
    .prepare(`
      INSERT INTO call_outcomes
        (event_uuid, program, closer_email, closer_phone, closer_name, lead_name,
         lead_phone, call_start, asistencia, resultado, status, answered_at)
      VALUES
        (@event_uuid, @program, @closer_email, @closer_phone, @closer_name, @lead_name,
         @lead_phone, @call_start, @asistencia, @resultado, 'auto', datetime('now'))
      ON CONFLICT(event_uuid) DO UPDATE SET
        asistencia = excluded.asistencia,
        resultado  = excluded.resultado,
        status     = 'auto',
        answered_at = datetime('now')
      WHERE call_outcomes.status = 'pending'
    `)
    .run(row);
}

// El outcome que el closer está respondiendo ahora. Tres capas, en orden:
//
//   1. Mid-flow CALIENTE: ya tiene asistencia y se le preguntó algo hace poco (esperando
//      el resultado de un show, o la fecha de una reagenda). Es lo que está contestando.
//   2. FIFO de las que aún esperan asistencia (Push 4 recién entregado).
//   3. Mid-flow FRÍO, como último recurso: nadie más reclama el mensaje.
//
// La ventana de frescura (capa 1) evita que una fila a medio flujo se lleve para siempre
// TODA respuesta del closer: sin ella, una reagenda sin fecha de ayer (o un show al que
// nunca le llegó el resultado) secuestraría la respuesta al Push 4 de hoy.
// Solo filas abiertas ('pending' | 'awaiting_date'); answered/auto/no_answer ya cerraron.
export function getActiveOutcomeForCloser(phone, windowMin = REPLY_WINDOW_MIN) {
  const p = normalizePhone(phone);
  if (!p) return null;
  const OPEN = `status IN ('pending','awaiting_date')`;

  const hot = db
    .prepare(`
      SELECT * FROM call_outcomes
      WHERE closer_phone = ? AND ${OPEN} AND asistencia IS NOT NULL
        AND prompted_at IS NOT NULL AND prompted_at >= datetime('now', ?)
      ORDER BY prompted_at DESC
      LIMIT 1
    `)
    .get(p, `-${Number(windowMin)} minutes`);
  if (hot) return hot;

  const fifo = db
    .prepare(`
      SELECT * FROM call_outcomes
      WHERE closer_phone = ? AND status = 'pending' AND asistencia IS NULL
      ORDER BY asked_at ASC
      LIMIT 1
    `)
    .get(p);
  if (fifo) return fifo;

  return (
    db
      .prepare(`
        SELECT * FROM call_outcomes
        WHERE closer_phone = ? AND ${OPEN} AND asistencia IS NOT NULL
        ORDER BY asked_at ASC
        LIMIT 1
      `)
      .get(p) || null
  );
}

// Guarda la asistencia y decide si el flujo sigue o cierra:
//   show       → sigue 'pending'       (falta el resultado)
//   reagendado → sigue 'awaiting_date' (falta la fecha de la nueva call, §18.AC)
//   no_show / cancelado → cierra en 'answered'
// `prompted_at` se refresca porque Juanito hace la repregunta acto seguido.
export function setOutcomeAsistencia(id, asistencia, rawReply = null) {
  const status =
    asistencia === 'show' ? 'pending' : asistencia === 'reagendado' ? 'awaiting_date' : 'answered';
  const closes = status === 'answered';
  return db
    .prepare(`
      UPDATE call_outcomes
      SET asistencia = ?, raw_reply = ?, status = ?,
          prompted_at = datetime('now'),
          answered_at = ${closes ? `datetime('now')` : `answered_at`}
      WHERE id = ?
    `)
    .run(asistencia, rawReply, status, id);
}

// Guarda el resultado y cierra el outcome ('answered').
export function setOutcomeResultado(id, resultado, rawReply = null) {
  return db
    .prepare(`
      UPDATE call_outcomes
      SET resultado = ?, raw_reply = COALESCE(raw_reply,'') || ' | ' || ?,
          status = 'answered', answered_at = datetime('now')
      WHERE id = ?
    `)
    .run(resultado, rawReply, id);
}

// Outcomes a los que toca insistir: pendientes, sin asistencia aún, preguntados
// hace > `minMinutes` y a los que aún no se les recordó (insistencia v1: una vez).
export function getDueOutcomeReminders(minMinutes = 30) {
  return db
    .prepare(`
      SELECT * FROM call_outcomes
      WHERE status = 'pending' AND asistencia IS NULL AND reminded = 0
        AND asked_at <= datetime('now', ? )
      ORDER BY asked_at ASC
    `)
    .all(`-${Number(minMinutes)} minutes`);
}

export function markOutcomeReminded(id) {
  return db.prepare(`UPDATE call_outcomes SET reminded = 1 WHERE id = ?`).run(id);
}

// Cierra como 'no_answer' los outcomes que ya recibieron su insistencia y siguen
// sin respuesta tras `minMinutes` más (quedan visibles como "sin registrar").
export function expireUnansweredOutcomes(minMinutes = 30) {
  return db
    .prepare(`
      UPDATE call_outcomes
      SET status = 'no_answer'
      WHERE status = 'pending' AND asistencia IS NULL AND reminded = 1
        AND asked_at <= datetime('now', ?)
    `)
    .run(`-${Number(minMinutes)} minutes`);
}

// ─── Barrido periódico de cosecha (§18.AH) ────────────────────────────────────
// El harvest en planNudge es UNA sola foto en el momento del Push 4 (call_end + gracia):
// si el closer todavía no había actualizado el deal en HubSpot en ese instante, la fila
// cae al nudge y, sin respuesta por WhatsApp, cierra sola como 'no_answer' — sin que nadie
// vuelva a mirar HubSpot después, aunque el closer sí actualice un rato más tarde. Este
// barrido re-consulta esas filas abandonadas. `maxAgeHours` es el tope: pasado ese tiempo
// se deja de perseguir una fila muerta (queda "sin registrar" definitivo).
export function getStaleHarvestCandidates({ maxAgeHours = 72 } = {}) {
  return db
    .prepare(`
      SELECT * FROM call_outcomes
      WHERE status IN ('pending', 'no_answer')
        AND asistencia IS NULL
        AND program IS NOT NULL
        AND event_uuid NOT LIKE 'manual:%'
        AND call_start >= datetime('now', ?)
      ORDER BY call_start ASC
    `)
    .all(`-${Number(maxAgeHours)} hours`);
}

// Aplica un outcome recuperado por el barrido: cierra la fila como 'auto' sin importar si
// venía 'pending' o ya había expirado a 'no_answer'. El guard `asistencia IS NULL` la hace
// idempotente frente a corridas superpuestas del barrido.
export function applyHarvestedOutcome(id, { asistencia, resultado = null } = {}) {
  return db
    .prepare(`
      UPDATE call_outcomes
      SET asistencia = ?, resultado = ?, status = 'auto', answered_at = datetime('now')
      WHERE id = ? AND asistencia IS NULL
    `)
    .run(asistencia, resultado, id);
}

// Filas de outcomes en una ventana UTC (para el reporte). La agregación por
// programa/closer se hace en JS puro (outcome-report.js) para poder testearla.
export function getOutcomesInWindow(fromUtc, toUtc) {
  return db
    .prepare(`
      SELECT program, closer_name, closer_email, lead_name, asistencia, resultado, status,
             call_start, rescheduled_to
      FROM call_outcomes
      WHERE call_start >= ? AND call_start < ?
      ORDER BY program, closer_name, call_start
    `)
    .all(fromUtc, toUtc);
}

// ─── Calendly: reagendas (§18.AC) ─────────────────────────────────────────────
// Cuando el closer marca "Reagendó", el outcome queda en 'awaiting_date' hasta que dé
// la fecha. Con la fecha, `createRescheduledCall` (calendly/reschedule.js) agenda la
// call nueva como pushes con un event_uuid sintético 'manual:<uuid>:<n>' y cierra esta
// fila. En call_outcomes solo sobreviven `rescheduled_to` y `reschedule_uuid`: eso ES
// la métrica. El estado temporal vive en calendly_pushes y lo purga cleanup().

// Cierra la reagenda con su fecha (o sin ella, si startUtc es null).
export function setOutcomeReschedule(id, { startUtc = null, uuid = null, rawReply = null } = {}) {
  return db
    .prepare(`
      UPDATE call_outcomes
      SET rescheduled_to = ?, reschedule_uuid = ?,
          raw_reply = TRIM(COALESCE(raw_reply, '') || ' | ' || COALESCE(?, '')),
          status = 'answered', answered_at = datetime('now')
      WHERE id = ?
    `)
    .run(startUtc, uuid, rawReply, id);
}

// Reagendas a las que hay que volver a pedirles la fecha. El cron corre 1 vez al día,
// así que el corte de 8h basta para que sea "al día siguiente" sin pelearse con el TZ
// (prompted_at está en UTC; el cron dispara 9am Bogotá).
export function getAwaitingDateOutcomes({ maxAsked = 3, minHours = 8 } = {}) {
  return db
    .prepare(`
      SELECT * FROM call_outcomes
      WHERE status = 'awaiting_date' AND reschedule_asked < ?
        AND (prompted_at IS NULL OR prompted_at <= datetime('now', ?))
      ORDER BY asked_at ASC
    `)
    .all(Number(maxAsked), `-${Number(minHours)} hours`);
}

export function markReschedulePrompted(id) {
  return db
    .prepare(`
      UPDATE call_outcomes
      SET reschedule_asked = reschedule_asked + 1, prompted_at = datetime('now')
      WHERE id = ?
    `)
    .run(id);
}

// Al tope de insistencias la reagenda se cierra SIN fecha: cuenta como movida en el
// reporte y deja de ocupar la ventana de captura del closer.
export function expireAwaitingDateOutcomes({ maxAsked = 3 } = {}) {
  return db
    .prepare(`
      UPDATE call_outcomes
      SET status = 'answered', answered_at = datetime('now')
      WHERE status = 'awaiting_date' AND reschedule_asked >= ?
    `)
    .run(Number(maxAsked));
}

// Pushes sintéticos aún por entregar (para el dedup contra Calendly del poll). Set
// chiquito: el match por lead se hace en JS (normalización de nombre/teléfono).
export function getPendingManualPushes() {
  return db
    .prepare(`
      SELECT * FROM calendly_pushes
      WHERE event_uuid LIKE 'manual:%' AND status = 'scheduled'
        AND call_start > datetime('now', '-1 hour')
    `)
    .all();
}

// Calls AGENDADAS en una ventana UTC — una fila por call (no por push). Es la fuente de la
// AGENDA de las 7am: a esa hora `call_outcomes` está vacío por diseño (su fila nace recién
// cuando se ENTREGA el Push 4, ~45 min DESPUÉS de cada call), así que preguntarle a esa tabla
// qué hay agendado hoy siempre devolvía cero. `calendly_pushes` sí tiene las calls del día
// desde que el poll las reserva → es la única fuente que existe a las 7am.
//
// Filtro `status IN ('scheduled','sent')`: descarta las calls cuyos pushes se saltaron, que es
// exactamente la señal de "esta call ya no va" — cancelada (`skip: cita canceled`), reagendada,
// o una reagenda manual superseded por el evento real de Calendly (supersedeManualPushes deja
// todos sus pushes en 'skipped'). Sin ese filtro se contarían dos veces las reagendas.
//
// Ojo: una cancelación se detecta al ENTREGAR el push, no antes. Una cita cancelada de noche
// puede seguir contada a las 7am; se auto-corrige cuando el Push 3 la salta.
//
// ⚠️ Agrupar por `event_uuid` NO alcanza (§18.AU). Una misma call puede tener DOS filas vivas
// con uuids distintos, porque hay tres fuentes que acuñan uuid propio: Calendly (uuid pelado),
// el poll del CRM ('hubspot:<id>') y la reagenda dictada por WhatsApp ('manual:<raíz>:<n>').
// Los supersedes que las reconcilian no cubren todos los cruces —el que faltaba: la reagenda
// manual cuya cita real vuelve por HubSpot, que nadie cancelaba— y esa call se contaba dos veces
// en la agenda del jefe. Por eso la segunda capa: `dedupeSameCall` (closer + minuto + LEAD).
// La regla de identidad vive en reschedule-logic.js, junto al `isSameLead` en que se apoya y a
// la medición que descartó deduplicar por slot a secas.
export function getScheduledCallsInWindow(fromUtc, toUtc) {
  const rows = db
    .prepare(`
      SELECT event_uuid,
             MAX(program)        AS program,
             MAX(closer_email)   AS closer_email,
             MAX(prospect_name)  AS prospect_name,
             MAX(prospect_phone) AS prospect_phone,
             MIN(call_start)     AS call_start
      FROM calendly_pushes
      WHERE call_start >= ? AND call_start < ?
        AND status IN ('scheduled', 'sent')
      GROUP BY event_uuid
      ORDER BY call_start
    `)
    .all(fromUtc, toUtc);
  return dedupeSameCall(rows);
}

// ¿Este closer ya tiene una call VIVA a esa hora CON ESTE MISMO LEAD? La fila o null.
//
// La usa `createRescheduledCall` antes de acuñar un uuid sintético: si la cita real ya entró
// (por Calendly o por el CRM), crear otra fila garantiza el doble push — justo lo que
// agenda-poll.js declara peor que perder uno.
//
// ⚠️ El lead NO es opcional en la comparación. Un closer puede tener dos leads distintos en el
// mismo slot (dobles reservas: 8 casos reales en 2 meses). Si esto matcheara solo por hora, una
// reagenda se "adoptaría" la call de OTRO lead y el outcome quedaría colgado del prospecto
// equivocado — un dato falso, peor que la fila duplicada que vino a evitar.
export function findLiveCallAtSlot(closerEmail, callStartUtc, { leadName = null, leadPhone = null } = {}) {
  const email = String(closerEmail || '').trim().toLowerCase();
  const slot = String(callStartUtc || '').trim().slice(0, 16);
  if (!email || !slot) return null;
  const rows = db
    .prepare(`
      SELECT event_uuid,
             MAX(program)        AS program,
             MAX(prospect_name)  AS prospect_name,
             MAX(prospect_phone) AS prospect_phone,
             MIN(call_start)     AS call_start
      FROM calendly_pushes
      WHERE status IN ('scheduled', 'sent')
        AND trim(lower(closer_email)) = ?
        AND substr(call_start, 1, 16) = ?
      GROUP BY event_uuid
    `)
    .all(email, slot);
  return (
    rows
      .filter((r) => isSameLead({ phone: r.prospect_phone, name: r.prospect_name }, { phone: leadPhone, name: leadName }))
      .sort((a, b) => sourceRankOf(a.event_uuid) - sourceRankOf(b.event_uuid))[0] || null
  );
}

// La reagenda volvió a entrar por Calendly → el evento real manda. Se cancelan los
// pushes sintéticos (así no se pregunta dos veces ni se cuenta dos veces) y el outcome
// que los originó apunta al uuid real.
export function supersedeManualPushes(manualUuid, realUuid) {
  const info = db
    .prepare(`
      UPDATE calendly_pushes
      SET status = 'skipped',
          skip_reason = 'superseded',
          message = COALESCE(message, '') || ' | skip: superseded por evento real ' || ?
      WHERE event_uuid = ? AND status = 'scheduled'
    `)
    .run(realUuid, manualUuid);
  db.prepare(`UPDATE call_outcomes SET reschedule_uuid = ? WHERE reschedule_uuid = ?`).run(
    realUuid,
    manualUuid
  );
  return info.changes;
}

// La reagenda la cosechamos de HubSpot pero SIN fecha nueva utilizable → hay que pedírsela al
// closer, igual que cuando la reagenda la dicta él por WhatsApp. Es `recordAutoOutcome` con la
// única diferencia que importa: el status queda en 'awaiting_date' (no 'auto'), que es lo que
// hace que `getAwaitingDateOutcomes` la recoja y el cron de las 9am insista hasta 3 veces.
//
// Sin esto, la cosecha CERRABA la reagenda en silencio: medido en producción, 5 de 5 reagendas
// cosechadas de HubSpot quedaron con reschedule_asked=0 y sin call nueva, mientras que las que
// venían por WhatsApp sí generaban call. La cosecha apagaba la pregunta sin reemplazarla (§18.AN).
export function recordRescheduleAwaitingDate(o) {
  const row = {
    program: null,
    closer_email: null,
    closer_phone: null,
    closer_name: null,
    lead_name: null,
    lead_phone: null,
    ...o,
  };
  row.closer_phone = normalizePhone(row.closer_phone) || null;
  return db
    .prepare(`
      INSERT INTO call_outcomes
        (event_uuid, program, closer_email, closer_phone, closer_name, lead_name,
         lead_phone, call_start, asistencia, status, asked_at)
      VALUES
        (@event_uuid, @program, @closer_email, @closer_phone, @closer_name, @lead_name,
         @lead_phone, @call_start, 'reagendado', 'awaiting_date', datetime('now'))
      ON CONFLICT(event_uuid) DO UPDATE SET
        asistencia = 'reagendado',
        status     = 'awaiting_date',
        asked_at   = datetime('now')
      WHERE call_outcomes.status = 'pending'
    `)
    .run(row);
}

// La cita que solo estaba en HubSpot terminó apareciendo en Calendly (el closer la pasó al
// sistema, o el sync llegó tarde). Calendly MANDA — igual que en `mergeAgendaSources` — así que
// los pushes sintéticos de HubSpot se cancelan: si no, el closer recibiría el MISMO aviso dos
// veces, que es peor que no recibirlo. Match por closer + minuto de arranque, la misma clave de
// identidad que usan el merge del reporte y agenda-poll.js.
export function supersedeHubspotPushes(closerEmail, callStartUtc, realUuid) {
  const info = db
    .prepare(`
      UPDATE calendly_pushes
      SET status = 'skipped',
          skip_reason = 'superseded',
          message = COALESCE(message, '') || ' | skip: la cita entró por Calendly como ' || ?
      WHERE event_uuid LIKE 'hubspot:%'
        AND status = 'scheduled'
        AND lower(closer_email) = lower(?)
        AND substr(call_start, 1, 16) = substr(?, 1, 16)
    `)
    .run(realUuid, String(closerEmail || ''), String(callStartUtc || ''));
  return info.changes;
}

// El lead se reagendó DENTRO del CRM (§18.AO) → la call vieja no va a ocurrir y sus pushes
// pendientes sobran: el Push 3 mandaría a preparar una llamada fantasma y el Push 4 preguntaría
// cómo fue. A diferencia de `supersedeHubspotPushes`, acá NO se filtra por 'hubspot:%': la cita
// original bien puede haber entrado por Calendly y haberse movido después en HubSpot.
//
// Solo toca filas 'scheduled'. Una ya 'sent' se deja como está a propósito: el mensaje salió,
// reescribir su estado no lo desmanda y solo perdería el rastro de que se envió.
export function supersedeRescheduledPushes(closerEmail, callStartUtc, nuevaCallStart) {
  const info = db
    .prepare(`
      UPDATE calendly_pushes
      SET status = 'skipped',
          skip_reason = 'rescheduled',
          message = COALESCE(message, '') || ' | skip: reagendada en HubSpot para ' || ?
      WHERE status = 'scheduled'
        -- trim además de lower: lower() sola deja pasar un email con espacios y el match falla
        -- en silencio, que en esta consulta significa "el push rancio se manda igual".
        AND trim(lower(closer_email)) = trim(lower(?))
        AND substr(call_start, 1, 16) = substr(trim(?), 1, 16)
    `)
    .run(String(nuevaCallStart || '?'), String(closerEmail || ''), String(callStartUtc || ''));
  return info.changes;
}

// Las calls que se movieron dentro del CRM, en una ventana. La agenda del jefe une Calendly con
// los meetings CRUDOS de HubSpot, y el meeting de una call reagendada sigue existiendo con su
// hora vieja: sin esto el reporte listaría una llamada que Juanito ya descartó (y §18.AC es
// explícita — una reagendada no es volumen, es movida).
// Devuelve [{ closer_email, call_start }]; el consumidor filtra por closer + minuto.
export function getRescheduledAwayCalls(fromUtc, toUtc) {
  return db
    .prepare(`
      SELECT DISTINCT lower(closer_email) AS closer_email, call_start
      FROM calendly_pushes
      WHERE skip_reason = 'rescheduled'
        AND call_start >= ? AND call_start < ?
    `)
    .all(fromUtc, toUtc);
}

// Calls que YA tienen fila de push en la ventana, sin importar su estado. Es la pregunta que
// necesita el poll de HubSpot para deduplicar, y NO es la misma que `getScheduledCallsInWindow`
// (que alimenta la agenda de las 7am y por eso solo cuenta 'scheduled'/'sent').
//
// La diferencia importa por un caso concreto: cuando el scan de reagendas cancela el push de una
// call que había entrado por Calendly, esa call desaparece de `getScheduledCallsInWindow` y el
// poll de HubSpot la ve "sin push" → le crearía uno nuevo bajo OTRO event_uuid ('hubspot:<id>'),
// resucitando justo lo que se acababa de cancelar.
export function getCallsWithAnyPushInWindow(fromUtc, toUtc) {
  return db
    .prepare(`
      SELECT event_uuid,
             MAX(program)       AS program,
             MAX(closer_email)  AS closer_email,
             MIN(call_start)    AS call_start
      FROM calendly_pushes
      WHERE call_start >= ? AND call_start < ?
      GROUP BY event_uuid
      ORDER BY call_start
    `)
    .all(fromUtc, toUtc);
}

// ─── Calendly: opt-in de closers (anti-baneo) ─────────────────────────────────
// Solo se envía en frío a un closer cuyo opt-in fue GANADO: el closer le escribió a
// Juanito (`source='self'`). Las filas sembradas/sin verificar (`source` null/'seeded')
// existen pero NO habilitan envío — evita mandar un mensaje en frío a un número que
// nunca habló con Juanito (el patrón que dispara softbans).
//
// `source`: 'self' = el closer escribió (vía handleCloserOptin) | 'seeded'/null = fabricado.
// `contactJid`: el JID desde el que escribió (auditoría; puede ser @lid sin resolver).
// El 'self' es "pegajoso": un upgrade seeded→self queda verificado y no se degrada.
export function registerOptin({ phone, closerEmail = null, name = null, source = 'seeded', contactJid = null }) {
  const p = normalizePhone(phone);
  if (!p) return null;
  return db
    .prepare(`
      INSERT INTO calendly_optins (phone, closer_email, name, source, contact_jid)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        closer_email = excluded.closer_email,
        name = excluded.name,
        source = CASE WHEN excluded.source = 'self' THEN 'self' ELSE calendly_optins.source END,
        contact_jid = COALESCE(excluded.contact_jid, calendly_optins.contact_jid)
    `)
    .run(p, closerEmail, name, source, contactJid);
}

// Existe la fila (verificada o no). Útil para el "ya estabas registrado".
export function isOptedIn(phone) {
  const p = normalizePhone(phone);
  if (!p) return false;
  return !!db.prepare(`SELECT 1 FROM calendly_optins WHERE phone = ?`).get(p);
}

// Opt-in GANADO: la única condición que habilita envío en frío (anti-ban).
export function isVerifiedOptedIn(phone) {
  const p = normalizePhone(phone);
  if (!p) return false;
  return !!db.prepare(`SELECT 1 FROM calendly_optins WHERE phone = ? AND source = 'self'`).get(p);
}

// Fila completa del opt-in (incluye `contact_jid`, `source` y `paused`) o null. La
// usa la entrega para enrutar al JID que YA estableció hilo con Juanito en vez del
// número canónico de closers.js — que puede no haber escrito nunca (anti-ban), y
// para respetar la pausa por-closer (`/calendly off <closer>`). Ver deliver().
export function getOptin(phone) {
  const p = normalizePhone(phone);
  if (!p) return null;
  return (
    db
      .prepare(
        `SELECT phone, closer_email, name, source, contact_jid, paused, registered_at
         FROM calendly_optins WHERE phone = ?`
      )
      .get(p) || null
  );
}

export function listOptins() {
  return db
    .prepare(`SELECT phone, closer_email, name, source, contact_jid, paused, registered_at FROM calendly_optins ORDER BY registered_at ASC`)
    .all();
}

// ─── Settings (toggles operativos en caliente, sin redeploy) ──────────────────
// key/value en la tabla `settings`. Hoy lo usa el botón de pánico de Calendly
// (`/calendly on|off`, admin). DRY_RUN sigue siendo el master dev-only del .env;
// esto es el control fino operativo (global + por-closer) que NO requiere redeploy.

export function getSetting(key, def = null) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? row.value : def;
}

export function setSetting(key, value) {
  return db
    .prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `)
    .run(key, value == null ? null : String(value));
}

// Pausa GLOBAL de los pushes de Calendly (botón de pánico).
export function isCalendlyPaused() {
  return getSetting('calendly_paused', '0') === '1';
}
export function setCalendlyPaused(paused) {
  return setSetting('calendly_paused', paused ? '1' : '0');
}

// Toggle GLOBAL de aprobación de DMs: si está ON, todo DM de un desconocido se retiene
// y pasa por el visto bueno del jefe antes de responder (ver handlePublicDm + pending_replies
// kind='dm'). OFF (default) = Juanito responde directo, como siempre.
export function isDmApprovalOn() {
  return getSetting('dm_approval', '0') === '1';
}
export function setDmApproval(on) {
  return setSetting('dm_approval', on ? '1' : '0');
}

// Pausa por-closer, por IDENTIDAD (email). Vive en la tabla `settings` (key
// `calendly_pause:<email>`), NO en la fila del opt-in: una persona con dos identidades comparte
// UN solo opt-in (mismo teléfono) pero se pausa por programa (email distinto por Conexión). Ver
// la invariante en src/calendly/closers.js. `/calendly off <closer> <cuenta>` apaga una identidad,
// `todo` apaga todas. deliver() consulta isCloserPaused(closerEmail) de la CITA. Devuelve 1
// (siempre aplica; el comando decide, con isOptedIn, si además tenía sentido — ver commands.js).
const pauseKey = (email) => `calendly_pause:${String(email || '').toLowerCase().trim()}`;

export function setCloserPaused(email, paused) {
  const e = String(email || '').toLowerCase().trim();
  if (!e) return 0;
  setSetting(pauseKey(e), paused ? '1' : '0');
  return 1;
}

export function isCloserPaused(email) {
  const e = String(email || '').toLowerCase().trim();
  if (!e) return false;
  return getSetting(pauseKey(e), '0') === '1';
}

// Emails de las identidades pausadas hoy (para el estado de /calendly). Lee las keys
// `calendly_pause:%` con valor '1'.
export function listCloserPauses() {
  return db
    .prepare(`SELECT key FROM settings WHERE key LIKE 'calendly_pause:%' AND value = '1'`)
    .all()
    .map((r) => r.key.slice('calendly_pause:'.length));
}

// ─── Grupos autorizados (default-deny anti-secuestro) ─────────────────────────
// Juanito solo responde en grupos listados aquí. Se autorizan automáticamente
// cuando un boss/admin lo agrega o es participante, o a mano con `/grupo on`.

export function isGroupAuthorized(groupId) {
  if (!groupId) return false;
  return !!db.prepare(`SELECT 1 FROM authorized_groups WHERE group_id = ?`).get(groupId);
}

export function authorizeGroup({ groupId, groupName = null, authorizedBy = null }) {
  if (!groupId) return;
  db.prepare(`
    INSERT INTO authorized_groups (group_id, group_name, authorized_by) VALUES (?, ?, ?)
    ON CONFLICT(group_id) DO UPDATE SET
      group_name = COALESCE(excluded.group_name, group_name),
      authorized_by = excluded.authorized_by,
      authorized_at = CURRENT_TIMESTAMP
  `).run(groupId, groupName, authorizedBy);
}

export function deauthorizeGroup(groupId) {
  return db.prepare(`DELETE FROM authorized_groups WHERE group_id = ?`).run(groupId).changes;
}

export function listAuthorizedGroups() {
  return db
    .prepare(`SELECT group_id, group_name, authorized_by, authorized_at, require_approval FROM authorized_groups ORDER BY authorized_at ASC`)
    .all();
}

// ─── Aprobación de respuestas en grupos (flag por grupo) ──────────────────────
// Si require_approval = 1, las respuestas de Juanito en ese grupo NO se publican
// directo: pasan por el jefe (ver pending_replies). El grupo debe estar autorizado.

export function setGroupApproval(groupId, enabled) {
  return db
    .prepare(`UPDATE authorized_groups SET require_approval = ? WHERE group_id = ?`)
    .run(enabled ? 1 : 0, groupId).changes;
}

export function getGroupApproval(groupId) {
  if (!groupId) return false;
  const row = db.prepare(`SELECT require_approval FROM authorized_groups WHERE group_id = ?`).get(groupId);
  return !!row?.require_approval;
}

export function listApprovalGroups() {
  return db
    .prepare(`SELECT group_id, group_name FROM authorized_groups WHERE require_approval = 1 ORDER BY group_name`)
    .all();
}

// ─── Rate limiting de grupos ──────────────────────────────────────────────────
// Incrementa SIEMPRE el contador (cuenta intentos, no solo permitidos) y devuelve
// { allowed, count }. Contar intentos permite detectar la PRIMERA denegación del
// día (count === limit + 1) para avisar una sola vez en vez de silencio (§18.D P2).

export function checkAndIncrementGroupUsage(sender, limit) {
  const today = new Date().toLocaleDateString('en-CA', {
    timeZone: process.env.TZ || 'America/Bogota',
  }); // YYYY-MM-DD en hora local

  db.prepare(`
    INSERT INTO group_usage (sender, date, count) VALUES (?, ?, 1)
    ON CONFLICT(sender, date) DO UPDATE SET count = count + 1
  `).run(sender, today);

  const { count } = db
    .prepare(`SELECT count FROM group_usage WHERE sender = ? AND date = ?`)
    .get(sender, today);

  return { allowed: count <= limit, count };
}

// ─── Tope anti-ráfaga de respuestas del bot por grupo/hora ────────────────────
// Cuenta cuántas respuestas AUTÓNOMAS publicó el bot en un grupo en la hora local
// actual. Incrementa SIEMPRE y devuelve { allowed, count } (misma forma que el rate
// limit por remitente). Sirve para que el bot no parezca ametralladora en un grupo.

export function checkAndIncrementGroupReplyQuota(groupId, hourlyCap) {
  const tz = process.env.TZ || 'America/Bogota';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  const hour = parts.hour === '24' ? '00' : parts.hour; // algunos ICU dan '24' a medianoche
  const bucket = `${parts.year}-${parts.month}-${parts.day}-${hour}`; // 'YYYY-MM-DD-HH' local

  db.prepare(`
    INSERT INTO group_reply_usage (group_id, hour_bucket, count) VALUES (?, ?, 1)
    ON CONFLICT(group_id, hour_bucket) DO UPDATE SET count = count + 1
  `).run(groupId, bucket);

  const { count } = db
    .prepare(`SELECT count FROM group_reply_usage WHERE group_id = ? AND hour_bucket = ?`)
    .get(groupId, bucket);

  return { allowed: count <= hourlyCap, count };
}

// ─── Personalidad por grupo ───────────────────────────────────────────────────
// Texto configurado por un admin (/persona) que se inyecta en el prompt de grupo
// de ESE chat. Aditivo sobre el prompt aislado: no reabre datos privados.

export function setGroupPersona({ groupId, groupName, persona, updatedBy }) {
  db.prepare(`
    INSERT INTO group_personality (group_id, group_name, persona, updated_by, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(group_id) DO UPDATE SET
      group_name = excluded.group_name,
      persona = excluded.persona,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `).run(groupId, groupName ?? null, persona, updatedBy ?? null);
}

export function getGroupPersona(groupId) {
  if (!groupId) return null;
  const row = db.prepare(`SELECT persona FROM group_personality WHERE group_id = ?`).get(groupId);
  return row?.persona ?? null;
}

export function deleteGroupPersona(groupId) {
  return db.prepare(`DELETE FROM group_personality WHERE group_id = ?`).run(groupId).changes;
}

export function listGroupPersonas() {
  return db
    .prepare(`SELECT group_id, group_name, persona, updated_by, updated_at FROM group_personality ORDER BY group_name`)
    .all();
}

// ─── Mensajes recurrentes a grupos ────────────────────────────────────────────
// Creados por jefe/admin vía DM (tool schedule_group_message); el scheduler los
// entrega cuando isRecurringDue dice que toca (días + hora + anti doble-envío).

export function createScheduledMessage({ groupId, groupName, days, timeHm, text, createdBy, kind = 'fixed', brief = null }) {
  const info = db.prepare(`
    INSERT INTO scheduled_messages (group_id, group_name, days, time_hm, text, created_by, kind, brief)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(groupId, groupName ?? null, days, timeHm, text ?? '', createdBy ?? null, kind, brief);
  return info.lastInsertRowid;
}

export function listScheduledMessages({ activeOnly = true } = {}) {
  const where = activeOnly ? 'WHERE active = 1' : '';
  return db
    .prepare(`SELECT id, group_id, group_name, days, time_hm, text, created_by, last_sent_date, active, kind, brief
              FROM scheduled_messages ${where} ORDER BY id`)
    .all();
}

// Actualiza SOLO los campos presentes de un mensaje programado ACTIVO. Existe porque sin esto
// afinar un brief obligaba a crear una fila nueva cada vez, y así nacieron los cuatro duplicados
// del 19-jun que estuvieron 11 semanas mandando el mensaje por duplicado (§18.BS).
export function updateScheduledMessage(id, { days, timeHm, text, brief } = {}) {
  const sets = [];
  const vals = [];
  if (days !== undefined) { sets.push('days = ?'); vals.push(days); }
  if (timeHm !== undefined) { sets.push('time_hm = ?'); vals.push(timeHm); }
  if (text !== undefined) { sets.push('text = ?'); vals.push(text); }
  if (brief !== undefined) { sets.push('brief = ?'); vals.push(brief); }
  if (!sets.length) return 0;
  vals.push(id);
  return db
    .prepare(`UPDATE scheduled_messages SET ${sets.join(', ')} WHERE id = ? AND active = 1`)
    .run(...vals).changes;
}

// ¿Ya hay una fila ACTIVA para el mismo grupo, los mismos días y la misma hora? Alimenta el
// guardia anti-duplicado del tool: dos filas así son indistinguibles desde WhatsApp y publican
// las dos (§18.BS).
export function findScheduledDuplicate({ groupId, days, timeHm }) {
  return (
    db
      .prepare(`SELECT * FROM scheduled_messages WHERE active = 1 AND group_id = ? AND days = ? AND time_hm = ?`)
      .get(groupId, days, timeHm) || null
  );
}

export function cancelScheduledMessage(id) {
  return db.prepare(`UPDATE scheduled_messages SET active = 0 WHERE id = ? AND active = 1`).run(id).changes;
}

export function markScheduledMessageSent(id, dateStr) {
  db.prepare(`UPDATE scheduled_messages SET last_sent_date = ? WHERE id = ?`).run(dateStr, id);
}

// ─── Mensajes/recordatorios a TERCEROS (tool schedule_outreach) ───────────────
// Los crea el jefe por DM; el scheduler (outreach.js) redacta y entrega según recur_kind.
// Solo se listan/entregan los activos (active=1 AND status='active').

export function createOutreach({
  toPhone,
  toName = null,
  intent,
  recurKind,
  dueAt = null,
  intervalMin = null,
  nextDueAt = null,
  days = null,
  timeHm = null,
  untilAt = null,
  maxCount = null,
  respectQuiet = 1,
  createdBy = null,
  senderName = null,
}) {
  const info = db.prepare(`
    INSERT INTO outreach_schedules
      (to_phone, to_name, intent, recur_kind, due_at, interval_min, next_due_at,
       days, time_hm, until_at, max_count, respect_quiet, created_by, sender_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    toPhone,
    toName,
    intent,
    recurKind,
    dueAt,
    intervalMin,
    nextDueAt,
    days,
    timeHm,
    untilAt,
    maxCount,
    respectQuiet ? 1 : 0,
    createdBy,
    senderName
  );
  return info.lastInsertRowid;
}

// Para el scheduler: todos los outreach vivos.
export function listActiveOutreach() {
  return db
    .prepare(`SELECT * FROM outreach_schedules WHERE active = 1 AND status = 'active' ORDER BY id`)
    .all();
}

// Para la tool (action=list): los del creador, vivos.
export function listOutreachByCreator(createdBy) {
  return db
    .prepare(`SELECT * FROM outreach_schedules
              WHERE active = 1 AND status = 'active' AND created_by = ? ORDER BY id`)
    .all(createdBy);
}

// Marca un envío hecho: incrementa el contador y, según el tipo, fija la próxima
// ejecución (interval) o el último día enviado (daily).
export function markOutreachSent(id, { nextDueAt = null, lastSentDate = null } = {}) {
  db.prepare(`
    UPDATE outreach_schedules
    SET sent_count = sent_count + 1,
        next_due_at = COALESCE(?, next_due_at),
        last_sent_date = COALESCE(?, last_sent_date)
    WHERE id = ?
  `).run(nextDueAt, lastSentDate, id);
}

// Cierra un outreach: 'done' (cumplió su parada) o 'cancelled' (el jefe lo paró).
export function finishOutreach(id, status = 'done') {
  return db
    .prepare(`UPDATE outreach_schedules SET status = ?, active = 0 WHERE id = ? AND active = 1`)
    .run(status, id).changes;
}

// ─── Tareas capturadas (tool capture_task) ────────────────────────────────────
// Órdenes del jefe que ninguna herramienta puede ejecutar: se anotan aquí y el equipo
// las gestiona con /tareas. createdBy = LID/jid de quien la pidió (destino del aviso "hecha").

export function createTask({ request, detail = null, createdBy = null }) {
  const info = db
    .prepare(`INSERT INTO pending_tasks (request, detail, created_by) VALUES (?, ?, ?)`)
    .run(request, detail, createdBy);
  return info.lastInsertRowid;
}

// Para /tareas (list): las pendientes, más antiguas primero.
export function listPendingTasks() {
  return db
    .prepare(`SELECT * FROM pending_tasks WHERE status = 'pending' ORDER BY id`)
    .all();
}

export function getTask(id) {
  return db.prepare(`SELECT * FROM pending_tasks WHERE id = ?`).get(id) || null;
}

// Cierra una tarea: 'done' (el equipo la cumplió) o 'dismissed' (se descartó). Solo si
// sigue 'pending' (idempotente: una segunda llamada devuelve 0 cambios).
export function setTaskStatus(id, status, decidedBy = null) {
  return db
    .prepare(`UPDATE pending_tasks
              SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP
              WHERE id = ? AND status = 'pending'`)
    .run(status, decidedBy, id).changes;
}

// ─── Contexto del negocio (Fase 2) ────────────────────────────────────────────
// Conocimiento curado del negocio del jefe que se carga en el prompt. status 'active' se
// muestra; 'proposed' (extraído de chats) espera confirmación; 'archived' se olvidó.

export function createBusinessFact({ topic, fact, status = 'active', source = 'taught', createdBy = null }) {
  const info = db
    .prepare(`INSERT INTO business_context (topic, fact, status, source, created_by) VALUES (?, ?, ?, ?, ?)`)
    .run(topic, fact, status, source, createdBy);
  return info.lastInsertRowid;
}

// Hechos ACTIVOS (los que se cargan en el prompt), agrupables por topic. Orden estable por topic+id.
export function listBusinessContext() {
  return db
    .prepare(`SELECT * FROM business_context WHERE status = 'active' ORDER BY topic, id`)
    .all();
}

// Hechos PROPUESTOS (extraídos de chats, Fase 2B) esperando confirmación. Más antiguos primero.
export function listProposedBusinessFacts() {
  return db
    .prepare(`SELECT * FROM business_context WHERE status = 'proposed' ORDER BY id`)
    .all();
}

export function getBusinessFact(id) {
  return db.prepare(`SELECT * FROM business_context WHERE id = ?`).get(id) || null;
}

// Cambia el estado de un hecho (active | proposed | archived). Para confirmar un propuesto
// ('proposed'→'active'), descartarlo ('proposed'→'archived') u olvidar uno activo
// ('active'→'archived'). Idempotente respecto al estado destino: solo cambia si difiere.
export function setBusinessFactStatus(id, status, decidedBy = null) {
  return db
    .prepare(`UPDATE business_context
              SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP
              WHERE id = ? AND status != ?`)
    .run(status, decidedBy, id, status).changes;
}

// ─── Borradores con aprobación (kind='generated') ─────────────────────────────
// Un borrador por (scheduled_id, publish_date). El flujo: el scheduler lo genera
// → 'pending' → el jefe aprueba ('approved') → el scheduler publica ('published').
// Una corrección REEMPLAZA el texto del mismo borrador (sigue 'pending').

export function createDraft({ scheduledId, publishDate, draft }) {
  const info = db.prepare(`
    INSERT INTO scheduled_drafts (scheduled_id, publish_date, draft)
    VALUES (?, ?, ?)
    ON CONFLICT(scheduled_id, publish_date) DO NOTHING
  `).run(scheduledId, publishDate, draft);
  return info.changes ? info.lastInsertRowid : null; // null = ya existía
}

export function getDraft(id) {
  return db.prepare(`SELECT * FROM scheduled_drafts WHERE id = ?`).get(id) || null;
}

export function getDraftFor(scheduledId, publishDate) {
  return (
    db.prepare(`SELECT * FROM scheduled_drafts WHERE scheduled_id = ? AND publish_date = ?`).get(scheduledId, publishDate) ||
    null
  );
}

export function listDraftsForDate(publishDate) {
  return db
    .prepare(`SELECT d.*, s.group_name, s.time_hm
              FROM scheduled_drafts d JOIN scheduled_messages s ON s.id = d.scheduled_id
              WHERE d.publish_date = ? ORDER BY s.time_hm`)
    .all(publishDate);
}

export function listPendingDrafts(publishDate) {
  return db
    .prepare(`SELECT d.*, s.group_name, s.time_hm
              FROM scheduled_drafts d JOIN scheduled_messages s ON s.id = d.scheduled_id
              WHERE d.publish_date = ? AND d.status = 'pending' ORDER BY s.time_hm`)
    .all(publishDate);
}

// Corrección: reemplaza el texto y vuelve (o sigue) en 'pending'.
export function reviseDraft(id, newDraft, feedback) {
  return db.prepare(`
    UPDATE scheduled_drafts SET draft = ?, feedback = ?, status = 'pending', decided_at = NULL
    WHERE id = ? AND status IN ('pending', 'approved')
  `).run(newDraft, feedback ?? null, id).changes;
}

export function approveDraft(id) {
  return db.prepare(`
    UPDATE scheduled_drafts SET status = 'approved', decided_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'pending'
  `).run(id).changes;
}

export function markDraftPublished(id) {
  return db.prepare(`
    UPDATE scheduled_drafts SET status = 'published' WHERE id = ? AND status = 'approved'
  `).run(id).changes;
}

// Descarta un borrador (pendiente o aprobado-no-publicado): no se publica hoy. El próximo
// día programado se genera uno nuevo (el UNIQUE es por (scheduled_id, publish_date)).
export function discardDraft(id) {
  return db.prepare(`
    UPDATE scheduled_drafts SET status = 'discarded', decided_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('pending', 'approved')
  `).run(id).changes;
}

// ─── Respuestas de grupo pendientes de aprobación ─────────────────────────────
// En grupos con require_approval=1, la respuesta de Juanito se guarda aquí y se le
// manda al jefe por DM. created_at es UTC (CURRENT_TIMESTAMP) → la caducidad compara
// 100% en UTC con datetime('now') (Alpine sin tzdata, mismo criterio que calendly_pushes).

export function createPendingReply({
  groupId,
  groupName,
  triggerSender,
  triggerText,
  triggerMsgId,
  triggerParticipant,
  draft,
  kind = 'group',
  held = 0,
}) {
  const info = db.prepare(`
    INSERT INTO pending_replies
      (group_id, group_name, trigger_sender, trigger_text, trigger_msg_id, trigger_participant, draft, kind, held)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    groupId,
    groupName ?? null,
    triggerSender ?? null,
    triggerText ?? null,
    triggerMsgId ?? null,
    triggerParticipant ?? null,
    draft,
    kind,
    held ? 1 : 0
  );
  return info.lastInsertRowid;
}

export function getPendingReply(id) {
  return db.prepare(`SELECT * FROM pending_replies WHERE id = ?`).get(id) || null;
}

export function listPendingReplies() {
  return db
    .prepare(`SELECT * FROM pending_replies WHERE status = 'pending' ORDER BY created_at ASC`)
    .all();
}

// Aprueba una pendiente. Acepta también 'expired': si caducó (30 min sin decisión) y el
// jefe la quiere rescatar después ("apruebo #id"), la resucita → el cron de entrega la
// recoge y la publica. held=0 al aprobar (por si se aprueba una retenida directamente).
export function approvePendingReply(id) {
  return db.prepare(`
    UPDATE pending_replies SET status = 'approved', held = 0, decided_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('pending', 'expired')
  `).run(id).changes;
}

export function revisePendingReply(id, newDraft, feedback) {
  return db.prepare(`
    UPDATE pending_replies SET draft = ?, feedback = ?, status = 'pending', decided_at = NULL
    WHERE id = ? AND status IN ('pending', 'approved')
  `).run(newDraft, feedback ?? null, id).changes;
}

export function discardPendingReply(id) {
  return db.prepare(`
    UPDATE pending_replies SET status = 'discarded', decided_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('pending', 'approved', 'expired')
  `).run(id).changes;
}

// Aprobadas listas para enviar (las recoge el cron y las publica en el grupo).
export function listApprovedPendingReplies() {
  return db
    .prepare(`SELECT * FROM pending_replies WHERE status = 'approved' ORDER BY decided_at ASC`)
    .all();
}

export function markPendingReplySent(id) {
  return db.prepare(`
    UPDATE pending_replies SET status = 'sent' WHERE id = ? AND status = 'approved'
  `).run(id).changes;
}

// Respuestas pendientes con más de `ttlMin` minutos sin decisión → caducan.
// Excluye las retenidas en horario de descanso (held=1): esas no corren el reloj de TTL
// hasta que se liberan (releaseHeldPendingReply reinicia created_at al notificar al jefe).
export function listExpiredPendingReplies(ttlMin) {
  return db
    .prepare(`SELECT * FROM pending_replies
              WHERE status = 'pending' AND held = 0 AND created_at < datetime('now', ?)`)
    .all(`-${Number(ttlMin)} minutes`);
}

// Pendientes retenidas en horario de descanso (aún no notificadas al jefe).
export function listHeldPendingReplies() {
  return db
    .prepare(`SELECT * FROM pending_replies WHERE status = 'pending' AND held = 1 ORDER BY created_at ASC`)
    .all();
}

// Libera una retenida: el jefe ya volvió al horario laboral y se le notificó. Reinicia
// created_at a ahora para que el reloj de caducidad (30 min) arranque desde la notificación,
// no desde la madrugada en que entró.
export function releaseHeldPendingReply(id) {
  return db.prepare(`
    UPDATE pending_replies SET held = 0, created_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'pending' AND held = 1
  `).run(id).changes;
}

export function markPendingReplyExpired(id) {
  return db.prepare(`
    UPDATE pending_replies SET status = 'expired', decided_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'pending'
  `).run(id).changes;
}

export function markDraftReminded(id) {
  db.prepare(`UPDATE scheduled_drafts SET reminded = 1 WHERE id = ?`).run(id);
}

// Últimos textos PUBLICADOS de un mensaje programado (para que el generador varíe
// y no se repita día a día).
export function listRecentPublishedDrafts(scheduledId, limit = 3) {
  return db
    .prepare(`SELECT draft FROM scheduled_drafts
              WHERE scheduled_id = ? AND status = 'published'
              ORDER BY publish_date DESC LIMIT ?`)
    .all(scheduledId, limit)
    .map((r) => r.draft);
}

// ─── Setteo reportado por el closer (§18.AZ) ──────────────────────────────────
// Contraparte de lo que HubSpot registra. Todas las funciones exigen closer_email y lo
// llevan SIEMPRE en el WHERE: la identidad sale del JID de quien escribe (roles.closerOf),
// nunca del texto del mensaje. Es lo que impide que un closer lea o borre lo de otro.

// Inserta o acumula un setteo. Idempotente por (closer, lead, fecha): reportar dos veces al
// mismo lead el mismo día NO duplica la fila.
//
// Los flags se acumulan con MAX(viejo, nuevo) y NUNCA bajan de 1 a 0. Es deliberado: el
// closer reporta en tandas ("toqué a Juan" … 2h después … "Juan agendó"), así que el segundo
// mensaje llega sin los flags del primero. Con un UPDATE plano, ese segundo mensaje borraría
// el "contestó" que ya estaba. Bajar un flag es el trabajo de updateSetteoFlags.
//
// Coherencia del embudo: agendó ⇒ contestó, y vendió ⇒ contestó. Un lead no puede agendar sin
// haber contestado, así que se cierra acá y no en el parser — el parser tiene varias entradas
// (regex, IA, tool) y esta es la única puerta a la tabla.
export function upsertSetteo({
  closerEmail, closerPhone = null, closerName = null,
  leadName, leadNorm, fecha,
  contesto = 0, agendo = 0, vendio = 0,
  hubspotContactId = null, hubspotMatch = null, esCall = 0,
  rawReply = null, source = 'libre',
}) {
  if (!closerEmail || !leadNorm || !fecha) {
    throw new Error('upsertSetteo: closerEmail, leadNorm y fecha son obligatorios');
  }
  const c = contesto || agendo || vendio ? 1 : 0; // agendó/vendió implican que contestó
  return db
    .prepare(`
      INSERT INTO setteos (closer_email, closer_phone, closer_name, lead_name, lead_norm, fecha,
                           contesto, agendo, vendio, hubspot_contact_id, hubspot_match, es_call,
                           raw_reply, source)
      VALUES (@closerEmail, @closerPhone, @closerName, @leadName, @leadNorm, @fecha,
              @c, @agendo, @vendio, @hubspotContactId, @hubspotMatch, @esCall,
              @rawReply, @source)
      ON CONFLICT(closer_email, lead_norm, fecha) DO UPDATE SET
        contesto = MAX(contesto, excluded.contesto),
        agendo   = MAX(agendo,   excluded.agendo),
        vendio   = MAX(vendio,   excluded.vendio),
        -- el cruce con HubSpot solo se pisa si el nuevo trae algo: una 2ª mención sin
        -- consultar el CRM no debe borrar el match que ya se había resuelto
        hubspot_contact_id = COALESCE(excluded.hubspot_contact_id, hubspot_contact_id),
        hubspot_match      = COALESCE(excluded.hubspot_match, hubspot_match),
        es_call    = MAX(es_call, excluded.es_call),
        raw_reply  = TRIM(COALESCE(raw_reply, '') || ' | ' || COALESCE(excluded.raw_reply, '')),
        updated_at = datetime('now')
    `)
    .run({
      closerEmail: String(closerEmail).toLowerCase().trim(), closerPhone, closerName,
      leadName, leadNorm, fecha, c, agendo: agendo ? 1 : 0, vendio: vendio ? 1 : 0,
      hubspotContactId, hubspotMatch, esCall: esCall ? 1 : 0, rawReply, source,
    });
}

// Setteos de UN closer en un rango de fechas LOCALES (ambos extremos inclusive).
export function listSetteosForCloser({ closerEmail, desde, hasta }) {
  if (!closerEmail) return [];
  return db
    .prepare(`
      SELECT * FROM setteos
      WHERE closer_email = ? AND fecha >= ? AND fecha <= ?
      ORDER BY fecha DESC, created_at DESC
    `)
    .all(String(closerEmail).toLowerCase().trim(), desde, hasta);
}

// Resumen del embudo de un closer. `total` EXCLUYE los leads que resultaron ser de call (esos
// los mide el Push 4) — si no, el mismo lead contaría en dos métricas.
// `tasaSetteo` va sobre los que CONTESTARON, no sobre el total: una tasa sobre el total premia
// a quien tiene la lista más caliente, no a quien setea mejor.
export function summarizeSetteos({ closerEmail, desde, hasta }) {
  const email = String(closerEmail || '').toLowerCase().trim();
  const row =
    db
      .prepare(`
        SELECT COUNT(*)                  AS total,
               COALESCE(SUM(contesto),0) AS contestaron,
               COALESCE(SUM(agendo),0)   AS agendaron,
               COALESCE(SUM(vendio),0)   AS vendieron,
               COALESCE(SUM(CASE WHEN hubspot_match = 'ambiguous' THEN 1 ELSE 0 END),0) AS ambiguos
        FROM setteos
        WHERE closer_email = ? AND fecha >= ? AND fecha <= ? AND es_call = 0
      `)
      .get(email, desde, hasta) || {};
  const calls =
    db
      .prepare(`SELECT COUNT(*) AS n FROM setteos
                WHERE closer_email = ? AND fecha >= ? AND fecha <= ? AND es_call = 1`)
      .get(email, desde, hasta)?.n || 0;
  return {
    total: row.total || 0,
    contestaron: row.contestaron || 0,
    agendaron: row.agendaron || 0,
    vendieron: row.vendieron || 0,
    ambiguos: row.ambiguos || 0,
    eranCall: calls,
    tasaRespuesta: row.total ? row.contestaron / row.total : null,
    tasaSetteo: row.contestaron ? row.agendaron / row.contestaron : null,
  };
}

// Setteos de la ventana agrupados por closer — para el bloque del jefe.
export function setteosByCloser({ desde, hasta }) {
  return db
    .prepare(`
      SELECT closer_email, MAX(closer_name) AS closer_name, COUNT(*) AS setteos,
             COALESCE(SUM(contesto),0) AS contestaron,
             COALESCE(SUM(agendo),0)   AS agendaron,
             COALESCE(SUM(vendio),0)   AS vendieron
      FROM setteos
      WHERE fecha >= ? AND fecha <= ? AND es_call = 0
      GROUP BY closer_email
      ORDER BY setteos DESC, closer_email
    `)
    .all(desde, hasta);
}

// Borra un setteo del closer. El email va en el WHERE (no solo el id) para que un id ajeno
// —adivinado o filtrado— no borre la fila de otro. Devuelve el nº de filas borradas.
export function deleteSetteo({ id, closerEmail }) {
  if (!id || !closerEmail) return 0;
  return db
    .prepare(`DELETE FROM setteos WHERE id = ? AND closer_email = ?`)
    .run(Number(id), String(closerEmail).toLowerCase().trim()).changes;
}

// Corrige los flags de un setteo ya guardado — la ÚNICA vía para bajar un flag, que
// upsertSetteo nunca hace. Solo toca lo que se le pasa explícitamente.
export function updateSetteoFlags({ id, closerEmail, contesto, agendo, vendio }) {
  if (!id || !closerEmail) return 0;
  const sets = [];
  const args = {};
  for (const [k, v] of Object.entries({ contesto, agendo, vendio })) {
    if (v === undefined || v === null) continue;
    sets.push(`${k} = @${k}`);
    args[k] = v ? 1 : 0;
  }
  if (!sets.length) return 0;
  return db
    .prepare(`UPDATE setteos SET ${sets.join(', ')}, updated_at = datetime('now')
              WHERE id = @id AND closer_email = @email`)
    .run({ ...args, id: Number(id), email: String(closerEmail).toLowerCase().trim() }).changes;
}

// ─── Limpieza periódica ───────────────────────────────────────────────────────

export function cleanup() {
  const stmts = [
    `DELETE FROM messages WHERE created_at < datetime('now', '-60 days')`,
    `DELETE FROM reminders WHERE status = 'sent' AND due_at < datetime('now', '-30 days')`,
    `DELETE FROM group_context WHERE created_at < datetime('now', '-14 days')`,
    `DELETE FROM processed_messages WHERE created_at < datetime('now', '-7 days')`,
    `DELETE FROM calendly_pushes WHERE status != 'scheduled' AND created_at < datetime('now', '-30 days')`,
    // Pushes de reagendas (§18.AC) que nunca se entregaron —el closer perdió el opt-in, WA
    // estuvo caído— y cuya call ya pasó hace rato: basura, no memoria.
    `DELETE FROM calendly_pushes WHERE event_uuid LIKE 'manual:%' AND status = 'scheduled' AND call_start < datetime('now', '-7 days')`,
    `DELETE FROM group_usage WHERE date < date('now', 'localtime', '-7 days')`,
    `DELETE FROM group_reply_usage WHERE hour_bucket < strftime('%Y-%m-%d-%H', datetime('now', 'localtime', '-2 days'))`,
    `DELETE FROM outreach_schedules WHERE status != 'active' AND created_at < datetime('now', '-30 days')`,
  ];
  let total = 0;
  for (const sql of stmts) total += db.prepare(sql).run().changes;
  return total;
}

export default db;
