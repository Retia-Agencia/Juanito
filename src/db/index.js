// src/db/index.js
// Funciones de acceso a SQLite — importar desde cualquier módulo

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const DB_PATH = process.env.DB_PATH || './data/brain.sqlite';
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ─── Mensajes ────────────────────────────────────────────────────────────────

export function saveMessage({ role, content, source = 'bot', chatId = null }) {
  return db.prepare(`
    INSERT INTO messages (role, content, source, chat_id)
    VALUES (?, ?, ?, ?)
  `).run(role, content, source, chatId);
}

// Devuelve los últimos N mensajes como historial para Claude
export function getRecentHistory(limit = 20) {
  return db.prepare(`
    SELECT role, content FROM messages
    WHERE source = 'bot'
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit).reverse();
}

// ─── Recordatorios ───────────────────────────────────────────────────────────

export function saveReminder({ text, dueAt }) {
  return db.prepare(`
    INSERT INTO reminders (text, due_at) VALUES (?, ?)
  `).run(text, dueAt);
}

export function getPendingReminders() {
  return db.prepare(`
    SELECT * FROM reminders
    WHERE sent = 0 AND due_at <= datetime('now')
    ORDER BY due_at ASC
  `).all();
}

export function markReminderSent(id) {
  return db.prepare(`UPDATE reminders SET sent = 1 WHERE id = ?`).run(id);
}

export function getUpcomingReminders(hours = 24) {
  return db.prepare(`
    SELECT * FROM reminders
    WHERE sent = 0 AND due_at > datetime('now')
      AND due_at <= datetime('now', '+' || ? || ' hours')
    ORDER BY due_at ASC
  `).all(hours);
}

// ─── Contexto de grupos ───────────────────────────────────────────────────────

export function saveGroupContext({ groupId, groupName, summary, rawSnippet }) {
  return db.prepare(`
    INSERT INTO group_context (group_id, group_name, summary, raw_snippet)
    VALUES (?, ?, ?, ?)
  `).run(groupId, groupName || groupId, summary, rawSnippet || null);
}

export function getRecentGroupContext(limit = 10) {
  return db.prepare(`
    SELECT group_name, summary, created_at FROM group_context
    ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

// ─── Memoria de largo plazo ───────────────────────────────────────────────────

export function setMemory(key, value) {
  return db.prepare(`
    INSERT INTO memory (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, value);
}

export function getMemory(key) {
  return db.prepare(`SELECT value FROM memory WHERE key = ?`).get(key)?.value;
}

export function getAllMemory() {
  return db.prepare(`SELECT key, value FROM memory`).all();
}

// ─── Deduplicación de webhooks ────────────────────────────────────────────────
// Devuelve true si el mensaje es nuevo (y lo marca), false si ya se procesó.

export function markIfNew(messageId) {
  if (!messageId) return true; // sin ID no podemos deduplicar, dejamos pasar
  try {
    db.prepare(`INSERT INTO processed_messages (message_id) VALUES (?)`).run(messageId);
    return true;
  } catch (e) {
    // UNIQUE constraint → ya existía
    return false;
  }
}

// ─── Limpieza periódica (evitar que SQLite crezca sin límite) ─────────────────

export function cleanup() {
  const stmts = [
    // Mensajes de más de 60 días
    `DELETE FROM messages WHERE created_at < datetime('now', '-60 days')`,
    // Recordatorios ya enviados de más de 30 días
    `DELETE FROM reminders WHERE sent = 1 AND due_at < datetime('now', '-30 days')`,
    // Contexto de grupos de más de 14 días
    `DELETE FROM group_context WHERE created_at < datetime('now', '-14 days')`,
    // IDs de mensajes procesados de más de 7 días
    `DELETE FROM processed_messages WHERE created_at < datetime('now', '-7 days')`,
  ];
  let total = 0;
  for (const sql of stmts) total += db.prepare(sql).run().changes;
  return total;
}

export default db;
