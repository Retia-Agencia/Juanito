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

// Últimos N mensajes del jefe como historial para Claude (orden cronológico)
export function getRecentHistory(limit = 20) {
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

export function listOptins() {
  return db
    .prepare(`SELECT phone, closer_email, name, source, contact_jid, registered_at FROM calendly_optins ORDER BY registered_at ASC`)
    .all();
}

// ─── Rate limiting de grupos ──────────────────────────────────────────────────
// Devuelve true si el remitente puede enviar (e incrementa el contador),
// false si ya alcanzó el límite diario.

export function checkAndIncrementGroupUsage(sender, limit) {
  const today = new Date().toLocaleDateString('en-CA', {
    timeZone: process.env.TZ || 'America/Bogota',
  }); // YYYY-MM-DD en hora local

  const row = db
    .prepare(`SELECT count FROM group_usage WHERE sender = ? AND date = ?`)
    .get(sender, today);

  if ((row?.count || 0) >= limit) return false;

  db.prepare(`
    INSERT INTO group_usage (sender, date, count) VALUES (?, ?, 1)
    ON CONFLICT(sender, date) DO UPDATE SET count = count + 1
  `).run(sender, today);

  return true;
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
  ];
  let total = 0;
  for (const sql of stmts) total += db.prepare(sql).run().changes;
  return total;
}

export default db;
