// src/db/index.js
// Funciones de acceso a SQLite — importar desde cualquier módulo.
// Estas firmas son el "Contrato" que consume el Track B.

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { normalizePhone } from '../common/utils.js';

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

export function getPendingReminders() {
  return db
    .prepare(`
      SELECT * FROM reminders
      WHERE status = 'pending' AND due_at <= datetime('now')
      ORDER BY due_at ASC
    `)
    .all();
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
      WHERE status = 'pending' AND due_at > datetime('now')
        AND due_at <= datetime('now', '+' || ? || ' hours')
      ORDER BY due_at ASC
    `)
    .all(hours);
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
// Devuelve 'new' | 'rescheduled' | 'unchanged'. Solo actualiza filas todavía
// 'scheduled' (no resucita las ya 'sent'/'skipped').

export function scheduleCalendlyPush(p) {
  const existing = db
    .prepare(`SELECT id, status, call_start FROM calendly_pushes WHERE event_uuid = ? AND push_n = ?`)
    .get(p.event_uuid, p.push_n);

  if (!existing) {
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

  if (existing.status === 'scheduled' && existing.call_start !== p.call_start) {
    db.prepare(`
      UPDATE calendly_pushes
      SET closer_email = @closer_email, closer_phone = @closer_phone,
          prospect_name = @prospect_name, prospect_phone = @prospect_phone,
          call_start = @call_start, due_at = @due_at, message = @message
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
// Solo se envía a un closer si su número ya escribió a Juanito (quedó registrado).

export function registerOptin({ phone, closerEmail = null, name = null }) {
  const p = normalizePhone(phone);
  if (!p) return null;
  return db
    .prepare(`
      INSERT INTO calendly_optins (phone, closer_email, name)
      VALUES (?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        closer_email = excluded.closer_email, name = excluded.name
    `)
    .run(p, closerEmail, name);
}

export function isOptedIn(phone) {
  const p = normalizePhone(phone);
  if (!p) return false;
  return !!db.prepare(`SELECT 1 FROM calendly_optins WHERE phone = ?`).get(p);
}

export function listOptins() {
  return db
    .prepare(`SELECT phone, closer_email, name, registered_at FROM calendly_optins ORDER BY registered_at ASC`)
    .all();
}

// ─── Limpieza periódica ───────────────────────────────────────────────────────

export function cleanup() {
  const stmts = [
    `DELETE FROM messages WHERE created_at < datetime('now', '-60 days')`,
    `DELETE FROM reminders WHERE status = 'sent' AND due_at < datetime('now', '-30 days')`,
    `DELETE FROM group_context WHERE created_at < datetime('now', '-14 days')`,
    `DELETE FROM processed_messages WHERE created_at < datetime('now', '-7 days')`,
    `DELETE FROM calendly_pushes WHERE status != 'scheduled' AND created_at < datetime('now', '-30 days')`,
  ];
  let total = 0;
  for (const sql of stmts) total += db.prepare(sql).run().changes;
  return total;
}

export default db;
