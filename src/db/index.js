// src/db/index.js
// Funciones de acceso a SQLite — importar desde cualquier módulo.
// Estas firmas son el "Contrato" que consume el Track B.

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { normalizePhone } from '../common/utils.js';
import { decidePushAction } from '../calendly/push-logic.js';

const DB_PATH = process.env.DB_PATH || './data/brain.sqlite';
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

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
export function getRecentHistory(limit = 20, chatId = null) {
  if (chatId) {
    return db
      .prepare(`
        SELECT role, content FROM messages
        WHERE source = 'bot' AND chat_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(chatId, limit)
      .reverse();
  }
  return db
    .prepare(`
      SELECT role, content FROM messages
      WHERE source = 'bot'
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(limit)
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

export function saveReminder({ text, dueAt, toPhone = null, createdBy = null }) {
  return db
    .prepare(`
      INSERT INTO reminders (text, due_at, to_phone, created_by, status)
      VALUES (?, ?, ?, ?, 'pending')
    `)
    .run(text, dueAt, toPhone, createdBy);
}

// Hora local como string YYYY-MM-DD HH:MM:SS comparable con due_at.
// SQLite 'localtime' falla en Alpine (sin tzdata), así que usamos JS Date.
function localNow(offsetHours = 0) {
  return new Date(Date.now() + offsetHours * 3600000).toLocaleString('sv', {
    timeZone: process.env.TZ || 'America/Bogota',
  });
}

export function getPendingReminders() {
  return db
    .prepare(`
      SELECT * FROM reminders
      WHERE status = 'pending' AND due_at <= ?
      ORDER BY due_at ASC
    `)
    .all(localNow());
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

export function markReminderFailed(id) {
  return db.prepare(`UPDATE reminders SET status = 'failed' WHERE id = ?`).run(id);
}

// Incrementa el contador de intentos y devuelve el nuevo valor (uso interno del scheduler)
export function incrementReminderAttempt(id) {
  db.prepare(`UPDATE reminders SET attempts = attempts + 1 WHERE id = ?`).run(id);
  return db.prepare(`SELECT attempts FROM reminders WHERE id = ?`).get(id)?.attempts ?? 0;
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
      SELECT id, text, due_at, to_phone FROM reminders
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

export function setMemory(key, value) {
  return db
    .prepare(`
      INSERT INTO memory (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `)
    .run(key, value);
}

export function getMemory(key) {
  return db.prepare(`SELECT value FROM memory WHERE key = ?`).get(key)?.value;
}

export function getAllMemory() {
  return db.prepare(`SELECT key, value FROM memory`).all();
}

export function searchMemory(query) {
  return db
    .prepare(`
      SELECT key, value, updated_at FROM memory
      WHERE key LIKE ? OR value LIKE ?
      ORDER BY updated_at DESC
      LIMIT 20
    `)
    .all(`%${query}%`, `%${query}%`);
}

// ─── Deduplicación de webhooks ────────────────────────────────────────────────
// Devuelve true si el mensaje es nuevo (y lo marca), false si ya se procesó.

export function markIfNew(messageId) {
  if (!messageId) return true; // sin ID no podemos deduplicar, dejamos pasar
  try {
    db.prepare(`INSERT INTO processed_messages (message_id) VALUES (?)`).run(messageId);
    return true;
  } catch {
    return false; // UNIQUE constraint → ya existía
  }
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

  if (action === 'insert') {
    db.prepare(`
      INSERT INTO calendly_pushes
        (event_uuid, push_n, closer_email, closer_phone, prospect_name,
         prospect_phone, call_start, due_at, message)
      VALUES
        (@event_uuid, @push_n, @closer_email, @closer_phone, @prospect_name,
         @prospect_phone, @call_start, @due_at, @message)
    `).run(p);
    return 'new';
  }

  if (action === 'reschedule') {
    // Si la fila ya estaba 'sent', volverla a 'scheduled' y limpiar sent_at para
    // que el cron la vuelva a entregar a la nueva hora.
    const statusClause = resetFromSent ? `, status = 'scheduled', sent_at = NULL` : '';
    db.prepare(`
      UPDATE calendly_pushes
      SET closer_email = @closer_email, closer_phone = @closer_phone,
          prospect_name = @prospect_name, prospect_phone = @prospect_phone,
          call_start = @call_start, due_at = @due_at, message = @message${statusClause}
      WHERE id = @id
    `).run({ ...p, id: existing.id });
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

export function markCalendlyPushSent(id) {
  return db
    .prepare(`UPDATE calendly_pushes SET status = 'sent', sent_at = datetime('now') WHERE id = ?`)
    .run(id);
}

export function markCalendlyPushSkipped(id, reason = '') {
  return db
    .prepare(
      `UPDATE calendly_pushes SET status = 'skipped', message = COALESCE(message,'') || ' | skip: ' || ? WHERE id = ?`
    )
    .run(reason, id);
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

// Pausa por-closer: marca la fila del opt-in. Devuelve el # de filas afectadas
// (0 si el closer no tiene opt-in registrado todavía).
export function setCloserPaused(phone, paused) {
  const p = normalizePhone(phone);
  if (!p) return 0;
  return db
    .prepare(`UPDATE calendly_optins SET paused = ? WHERE phone = ?`)
    .run(paused ? 1 : 0, p).changes;
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

export function cancelScheduledMessage(id) {
  return db.prepare(`UPDATE scheduled_messages SET active = 0 WHERE id = ? AND active = 1`).run(id).changes;
}

export function markScheduledMessageSent(id, dateStr) {
  db.prepare(`UPDATE scheduled_messages SET last_sent_date = ? WHERE id = ?`).run(dateStr, id);
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
}) {
  const info = db.prepare(`
    INSERT INTO pending_replies
      (group_id, group_name, trigger_sender, trigger_text, trigger_msg_id, trigger_participant, draft, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    groupId,
    groupName ?? null,
    triggerSender ?? null,
    triggerText ?? null,
    triggerMsgId ?? null,
    triggerParticipant ?? null,
    draft,
    kind
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

export function approvePendingReply(id) {
  return db.prepare(`
    UPDATE pending_replies SET status = 'approved', decided_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'pending'
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
    WHERE id = ? AND status IN ('pending', 'approved')
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
export function listExpiredPendingReplies(ttlMin) {
  return db
    .prepare(`SELECT * FROM pending_replies
              WHERE status = 'pending' AND created_at < datetime('now', ?)`)
    .all(`-${Number(ttlMin)} minutes`);
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

// ─── Limpieza periódica ───────────────────────────────────────────────────────

export function cleanup() {
  const stmts = [
    `DELETE FROM messages WHERE created_at < datetime('now', '-60 days')`,
    `DELETE FROM reminders WHERE status = 'sent' AND due_at < datetime('now', '-30 days')`,
    `DELETE FROM group_context WHERE created_at < datetime('now', '-14 days')`,
    `DELETE FROM processed_messages WHERE created_at < datetime('now', '-7 days')`,
    `DELETE FROM calendly_pushes WHERE status != 'scheduled' AND created_at < datetime('now', '-30 days')`,
    `DELETE FROM group_usage WHERE date < date('now', 'localtime', '-7 days')`,
    `DELETE FROM group_reply_usage WHERE hour_bucket < strftime('%Y-%m-%d-%H', datetime('now', 'localtime', '-2 days'))`,
  ];
  let total = 0;
  for (const sql of stmts) total += db.prepare(sql).run().changes;
  return total;
}

export default db;
