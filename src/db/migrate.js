// src/db/migrate.js
// Crea las tablas si no existen — seguro de correr múltiples veces

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import 'dotenv/config';

const DB_PATH = process.env.DB_PATH || './data/brain.sqlite';
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

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

  -- Recordatorios
  CREATE TABLE IF NOT EXISTS reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    text        TEXT NOT NULL,
    due_at      DATETIME NOT NULL,
    sent        INTEGER DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Contexto de grupos (resúmenes de lo que pasa)
  CREATE TABLE IF NOT EXISTS group_context (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id    TEXT NOT NULL,
    group_name  TEXT,
    summary     TEXT NOT NULL,
    raw_snippet TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Memoria de largo plazo (hechos que Claude debe recordar)
  CREATE TABLE IF NOT EXISTS memory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT UNIQUE NOT NULL,   -- ej: 'nombre_jefe', 'zona_horaria'
    value       TEXT NOT NULL,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Mensajes ya procesados (deduplicación de webhooks)
  CREATE TABLE IF NOT EXISTS processed_messages (
    message_id  TEXT PRIMARY KEY,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Índices para consultas frecuentes
  CREATE INDEX IF NOT EXISTS idx_messages_source_created ON messages(source, created_at);
  CREATE INDEX IF NOT EXISTS idx_reminders_pending ON reminders(sent, due_at);
  CREATE INDEX IF NOT EXISTS idx_group_context_created ON group_context(created_at);
`);

console.log('✅ Base de datos lista en', DB_PATH);
db.close();
