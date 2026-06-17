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
    status         TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | sending | sent | skipped
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

  -- Uso diario por remitente en grupos (rate limiting)
  CREATE TABLE IF NOT EXISTS group_usage (
    sender  TEXT NOT NULL,
    date    TEXT NOT NULL,   -- YYYY-MM-DD en hora local
    count   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (sender, date)
  );

  -- Configuración en caliente (key/value): toggles operativos sin redeploy
  -- (ej: 'calendly_paused' = '1' apaga TODOS los pushes al instante)
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Grupos autorizados (default-deny anti-secuestro): Juanito SOLO responde en
  -- grupos donde lo agregó un BOSS/ADMIN, donde un BOSS/ADMIN es participante, o
  -- que un admin habilitó con /grupo on. Un grupo NO listado aquí = no responde.
  CREATE TABLE IF NOT EXISTS authorized_groups (
    group_id         TEXT PRIMARY KEY,
    group_name       TEXT,
    authorized_by    TEXT,            -- JID/LID de quien autorizó, o 'participant'/'command'
    authorized_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    require_approval INTEGER NOT NULL DEFAULT 0  -- 1 = las respuestas de Juanito en este grupo pasan por el jefe
  );

  -- Personalidad por grupo: texto que un ADMIN configura (/persona) y se inyecta
  -- en el prompt de grupo de ese chat. Aditivo sobre el prompt AISLADO de grupos
  -- (no reabre memoria/recordatorios/datos del jefe).
  CREATE TABLE IF NOT EXISTS group_personality (
    group_id   TEXT PRIMARY KEY,
    group_name TEXT,
    persona    TEXT NOT NULL,
    updated_by TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Mensajes recurrentes a grupos (ej: invitación todos los jueves 8pm).
  -- Los crea el jefe/admin por DM (tool schedule_group_message) y los entrega el
  -- scheduler. days = CSV de días 0-6 (0=domingo), time_hm = 'HH:MM' hora local TZ.
  CREATE TABLE IF NOT EXISTS scheduled_messages (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id       TEXT NOT NULL,
    group_name     TEXT,
    days           TEXT NOT NULL,
    time_hm        TEXT NOT NULL,
    text           TEXT NOT NULL,
    created_by     TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_sent_date TEXT,            -- 'YYYY-MM-DD' local del último envío (anti doble-envío)
    active         INTEGER NOT NULL DEFAULT 1,
    kind           TEXT NOT NULL DEFAULT 'fixed',  -- 'fixed' | 'generated' (con aprobación)
    brief          TEXT             -- instrucción editorial para kind='generated'
  );

  -- Borradores de mensajes GENERADOS (kind='generated' en scheduled_messages):
  -- el scheduler genera el borrador con anticipación, se lo manda al jefe por DM,
  -- y SOLO se publica si fue aprobado. Un borrador por (mensaje, día).
  CREATE TABLE IF NOT EXISTS scheduled_drafts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    scheduled_id INTEGER NOT NULL,
    publish_date TEXT NOT NULL,      -- 'YYYY-MM-DD' local del día de publicación
    draft        TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|published|discarded
    feedback     TEXT,               -- última corrección aplicada (auditoría)
    reminded     INTEGER NOT NULL DEFAULT 0,       -- ya se avisó "sigue pendiente" a la hora de publicar
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    decided_at   DATETIME,
    UNIQUE(scheduled_id, publish_date)
  );

  -- Respuestas de grupo PENDIENTES de aprobación (solo en grupos con require_approval=1).
  -- Cuando mencionan a Juanito en uno de esos grupos, la respuesta NO se publica: se
  -- guarda aquí y se le manda al jefe por DM. El jefe aprueba/corrige/descarta; un cron
  -- envía las aprobadas y caduca las que llevan demasiado tiempo sin decisión.
  CREATE TABLE IF NOT EXISTS pending_replies (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id       TEXT NOT NULL,
    group_name     TEXT,
    trigger_sender TEXT,             -- quién mencionó (pushName o jid, para contexto)
    trigger_text   TEXT,             -- qué dijo (para que el jefe entienda el contexto)
    draft          TEXT NOT NULL,    -- respuesta propuesta por Juanito
    status         TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|sent|discarded|expired
    feedback       TEXT,             -- última corrección aplicada (auditoría)
    kind           TEXT NOT NULL DEFAULT 'group',  -- 'group' (mención en grupo) | 'dm' (DM de desconocido)
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    decided_at     DATETIME
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

// Opt-in anti-ban: distinguir opt-ins ganados ('self', el closer escribió) de los
// sembrados/sin verificar (null → no se envía en frío). `contact_jid` = JID desde el
// que escribió (auditoría). Filas viejas quedan sin verificar hasta backfill explícito.
addColumnIfMissing('calendly_optins', 'source', 'TEXT');
addColumnIfMissing('calendly_optins', 'contact_jid', 'TEXT');
// Pausa por-closer (botón de pánico fino: `/calendly off <closer>`). 0 = activo.
addColumnIfMissing('calendly_optins', 'paused', 'INTEGER DEFAULT 0');

// Mensajes programados GENERADOS (§18.E fase aprobación): kind 'fixed' (texto exacto,
// comportamiento original) | 'generated' (Claude redacta cada día según `brief` y se
// publica solo tras aprobación del jefe).
addColumnIfMissing('scheduled_messages', 'kind', "TEXT NOT NULL DEFAULT 'fixed'");
addColumnIfMissing('scheduled_messages', 'brief', 'TEXT');

// Aprobación de respuestas en grupos (solo grupos con el flag en ON): cuando mencionan a
// Juanito, su respuesta pasa por el jefe antes de publicarse. Flag por grupo.
addColumnIfMissing('authorized_groups', 'require_approval', 'INTEGER NOT NULL DEFAULT 0');

// Identidad del mensaje que disparó la respuesta pendiente → permite CITARLO (reply
// nativo) cuando la respuesta aprobada se publica minutos después.
addColumnIfMissing('pending_replies', 'trigger_msg_id', 'TEXT');
addColumnIfMissing('pending_replies', 'trigger_participant', 'TEXT');

// Tipo de pendiente: 'group' (mención en grupo con require_approval) | 'dm' (DM de un
// desconocido cuando el toggle global dm_approval está ON). Filas viejas quedan 'group'.
// El cron de entrega salta la verificación de grupo autorizado cuando kind='dm'.
addColumnIfMissing('pending_replies', 'kind', "TEXT NOT NULL DEFAULT 'group'");

// Tope anti-ráfaga: cuántas respuestas AUTÓNOMAS publicó el bot en cada grupo, por hora.
// hour_bucket = 'YYYY-MM-DD-HH' en hora local. Se limpia con el resto en la limpieza diaria.
db.exec(`
  CREATE TABLE IF NOT EXISTS group_reply_usage (
    group_id    TEXT NOT NULL,
    hour_bucket TEXT NOT NULL,   -- 'YYYY-MM-DD-HH' hora local
    count       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, hour_bucket)
  );
`);

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
  -- Cubre los queries calientes por chat (getRecentHistory/getRecentMessages filtran
  -- por chat_id + source + created_at); el índice (source, created_at) no los cubre.
  CREATE INDEX IF NOT EXISTS idx_messages_chat_source_created ON messages(chat_id, source, created_at);
  CREATE INDEX IF NOT EXISTS idx_reminders_pending ON reminders(status, due_at);
  CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
  CREATE INDEX IF NOT EXISTS idx_group_context_created ON group_context(created_at);
  CREATE INDEX IF NOT EXISTS idx_calendly_pushes_due ON calendly_pushes(status, due_at);
`);

console.log('✅ Base de datos lista en', DB_PATH);
db.close();
