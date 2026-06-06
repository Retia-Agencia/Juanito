// src/db/migrate.js
// Crea/actualiza las tablas — seguro de correr múltiples veces (idempotente).
// Soporta tanto bases nuevas como bases creadas con el esquema viejo.

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import 'dotenv/config';

const DB_PATH = process.env.DB_PATH || './data/brain.sqlite';
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function columnExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

// Añade una columna solo si no existe (SQLite no soporta ADD COLUMN IF NOT EXISTS)
function addColumnIfMissing(table, column, definition) {
  if (!columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`  + ${table}.${column} añadida`);
  }
}

// ─── 1. Tablas base (esquema completo para bases nuevas) ──────────────────────

db.exec(`
  -- Historial de conversaciones con el jefe
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    role        TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content     TEXT NOT NULL,
    source      TEXT DEFAULT 'bot',   -- 'bot' | 'group' | 'openwa'
    chat_id     TEXT,                 -- JID de WhatsApp
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Recordatorios (con destinatario arbitrario)
  CREATE TABLE IF NOT EXISTS reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    text        TEXT NOT NULL,
    due_at      DATETIME NOT NULL,
    to_phone    TEXT,                          -- destinatario; null = el jefe
    created_by  TEXT,                          -- quién lo agendó
    status      TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
    sent_at     DATETIME,
    attempts    INTEGER NOT NULL DEFAULT 0,    -- intentos de envío fallidos
    sent        INTEGER DEFAULT 0,             -- legacy, se mantiene por compatibilidad
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Resúmenes de chats/grupos
  CREATE TABLE IF NOT EXISTS group_context (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id     TEXT NOT NULL,
    group_name   TEXT,
    summary      TEXT NOT NULL,
    raw_snippet  TEXT,
    period_start DATETIME,
    period_end   DATETIME,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Directorio de contactos (resolver "Juan" -> número)
  CREATE TABLE IF NOT EXISTS contacts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT UNIQUE NOT NULL,
    phone       TEXT NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Memoria de largo plazo (hechos que Claude debe recordar)
  CREATE TABLE IF NOT EXISTS memory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT UNIQUE NOT NULL,
    value       TEXT NOT NULL,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Mensajes ya procesados (deduplicación de webhooks)
  CREATE TABLE IF NOT EXISTS processed_messages (
    message_id  TEXT PRIMARY KEY,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Pushes precall de Calendly (dedup + agenda de Push 3)
  CREATE TABLE IF NOT EXISTS calendly_pushes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    event_uuid     TEXT NOT NULL,
    push_n         INTEGER NOT NULL DEFAULT 3,
    closer_email   TEXT,
    closer_phone   TEXT,
    prospect_name  TEXT,
    prospect_phone TEXT,
    call_start     TEXT NOT NULL,                   -- 'YYYY-MM-DD HH:MM:SS' UTC
    due_at         TEXT NOT NULL,                   -- 'YYYY-MM-DD HH:MM:SS' UTC
    status         TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | sent | skipped
    message        TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    sent_at        DATETIME,
    UNIQUE(event_uuid, push_n)
  );

  -- Opt-in de closers: solo se les envía si primero le escribieron a Juanito
  -- (práctica anti-baneo: el bot nunca escribe a quien no lo contactó antes)
  CREATE TABLE IF NOT EXISTS calendly_optins (
    phone         TEXT PRIMARY KEY,        -- número normalizado (solo dígitos)
    closer_email  TEXT,
    name          TEXT,
    registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ─── 2. Migración de bases existentes (esquema viejo) ─────────────────────────

addColumnIfMissing('reminders', 'to_phone', 'TEXT');
addColumnIfMissing('reminders', 'created_by', 'TEXT');
addColumnIfMissing('reminders', 'status', "TEXT NOT NULL DEFAULT 'pending'");
addColumnIfMissing('reminders', 'sent_at', 'DATETIME');
addColumnIfMissing('reminders', 'attempts', 'INTEGER NOT NULL DEFAULT 0');

addColumnIfMissing('group_context', 'period_start', 'DATETIME');
addColumnIfMissing('group_context', 'period_end', 'DATETIME');

// Migrar el flag legacy `sent` -> `status` (una sola vez, idempotente)
if (columnExists('reminders', 'sent')) {
  const migrated = db
    .prepare(`UPDATE reminders SET status = 'sent', sent_at = COALESCE(sent_at, due_at)
              WHERE sent = 1 AND status = 'pending'`)
    .run();
  if (migrated.changes) console.log(`  ~ ${migrated.changes} recordatorios migrados sent->status`);
}

// ─── 3. Índices ───────────────────────────────────────────────────────────────

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_source_created ON messages(source, created_at);
  CREATE INDEX IF NOT EXISTS idx_reminders_pending ON reminders(status, due_at);
  CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
  CREATE INDEX IF NOT EXISTS idx_group_context_created ON group_context(created_at);
  CREATE INDEX IF NOT EXISTS idx_calendly_pushes_due ON calendly_pushes(status, due_at);
`);

console.log('✅ Base de datos lista en', DB_PATH);
db.close();
