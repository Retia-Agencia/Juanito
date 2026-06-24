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
    owner_lid   TEXT,               -- NULL = memoria del sistema; <LID> = personal de ese contacto (§18 1B)
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

  -- Mensajes/recordatorios a TERCEROS por instrucción del jefe (tool schedule_outreach).
  -- A diferencia de scheduled_messages (a GRUPOS) y reminders (texto seco), aquí Juanito
  -- redacta un mensaje NATURAL de parte del jefe y lo manda a una persona, una sola vez,
  -- por intervalo ('cada 40 min') o a diario/semanal a hora fija. Solo el jefe los crea.
  -- recur_kind: 'once' (due_at) | 'interval' (interval_min + next_due_at) | 'daily' (days + time_hm).
  -- Paradas (interval): until_at (hora/fecha límite) y/o max_count; pausa en quiet hours si respect_quiet.
  CREATE TABLE IF NOT EXISTS outreach_schedules (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    to_phone      TEXT NOT NULL,      -- destino normalizado
    to_name       TEXT,               -- nombre del contacto (redacción + avisos al jefe)
    intent        TEXT NOT NULL,      -- qué quiere el jefe que le diga (instrucción, no texto literal)
    recur_kind    TEXT NOT NULL,      -- 'once' | 'interval' | 'daily'
    due_at        DATETIME,           -- once: 'YYYY-MM-DD HH:MM:SS' local
    interval_min  INTEGER,            -- interval: cada N minutos
    next_due_at   DATETIME,           -- interval: próxima ejecución 'YYYY-MM-DD HH:MM:SS' local
    days          TEXT,               -- daily: CSV de días 0-6 (0=domingo)
    time_hm       TEXT,               -- daily: 'HH:MM' hora local
    until_at      DATETIME,           -- parada por fecha/hora 'YYYY-MM-DD HH:MM:SS' local (interval)
    max_count     INTEGER,            -- parada por nº de veces
    sent_count    INTEGER NOT NULL DEFAULT 0,
    respect_quiet INTEGER NOT NULL DEFAULT 1,  -- 1 = no escribe dentro de quiet hours (pausa)
    last_sent_date TEXT,              -- daily: 'YYYY-MM-DD' local del último envío (anti doble-envío)
    created_by    TEXT,
    status        TEXT NOT NULL DEFAULT 'active',  -- active | done | cancelled
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Órdenes libres del jefe que NO caen en ninguna herramienta (tool capture_task §18).
  -- Juanito las anota aquí en vez de negarse, y avisa al equipo (approvalsTarget). Un admin
  -- las gestiona con /tareas: al marcarlas 'done' se le avisa al solicitante. created_by es
  -- el LID/jid de quien la pidió (jefe/admin) — destino del aviso de "hecha".
  CREATE TABLE IF NOT EXISTS pending_tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    request     TEXT NOT NULL,      -- la orden en lenguaje natural
    detail      TEXT,               -- contexto opcional
    created_by  TEXT,               -- LID/jid de quien la pidió (jefe/admin)
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending | done | dismissed
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    decided_by  TEXT,
    decided_at  DATETIME
  );

  -- Contexto del NEGOCIO (Fase 2): conocimiento curado sobre el negocio del jefe (proceso de
  -- ventas, closers, productos, jerga, clientes, metas) que se carga en el prompt para que
  -- Juanito responda informado. status: 'active' (se carga en el prompt) | 'proposed' (extraído
  -- de chats, espera confirmación de jefe/admin antes de activarse — Fase 2B). topic categoriza
  -- para renderizar ordenado. source: 'taught' (enseñado con la acción dedicada) | 'chat' (extraído).
  CREATE TABLE IF NOT EXISTS business_context (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    topic       TEXT NOT NULL,      -- proceso | closers | productos | terminologia | clientes | metas | otro
    fact        TEXT NOT NULL,      -- el hecho del negocio en lenguaje natural
    status      TEXT NOT NULL DEFAULT 'active',  -- active | proposed | archived
    source      TEXT,               -- taught | chat (+ contexto de origen)
    created_by  TEXT,               -- LID/jid de quien lo enseñó/propuso
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    decided_by  TEXT,
    decided_at  DATETIME
  );
`);

// ─── 2. Migración de bases existentes (esquema viejo) ─────────────────────────

// Memoria por identidad (§18 1B): owner_lid separa la memoria del sistema (NULL, la escribe un
// admin con save_memory) de la PERSONAL de cada contacto (<LID>, vía remember_note). Antes la
// memoria era global y las notas de un admin se filtraban al contexto del jefe (y viceversa).
addColumnIfMissing('memory', 'owner_lid', 'TEXT');
// "Empezar limpio": las notas personales VIEJAS no tienen dueño fiable (y al menos una estaba
// envenenada), así que se descartan. Solo afecta filas legacy (boss_note:* sin owner_lid); las
// notas nuevas ya se guardan con owner_lid, así que esto nunca las toca. Idempotente.
db.prepare(`DELETE FROM memory WHERE key LIKE 'boss_note:%' AND owner_lid IS NULL`).run();

addColumnIfMissing('reminders', 'to_phone', 'TEXT');
addColumnIfMissing('reminders', 'created_by', 'TEXT');
addColumnIfMissing('reminders', 'status', "TEXT NOT NULL DEFAULT 'pending'");
addColumnIfMissing('reminders', 'sent_at', 'DATETIME');
addColumnIfMissing('reminders', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
// Recordatorios ÚNICOS dirigidos a un grupo (§18.Q): si to_group_id está, el scheduler
// publica el recordatorio EN ese grupo (vía la cola anti-ban) en vez de a una persona.
addColumnIfMissing('reminders', 'to_group_id', 'TEXT');
addColumnIfMissing('reminders', 'to_group_name', 'TEXT');

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

// Retenida en horario de descanso (quiet hours): se creó mientras el jefe "dormía", así
// que NO se le notificó todavía y NO cuenta para la caducidad por TTL. Al volver el horario
// laboral, un cron le manda el digest al jefe y la libera (held=0 + created_at=ahora → el
// reloj de 30 min arranca recién ahí). Filas viejas quedan held=0 (comportamiento de siempre).
addColumnIfMissing('pending_replies', 'held', 'INTEGER NOT NULL DEFAULT 0');

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
  -- La tabla messages registra TODO mensaje de grupo (lectura pasiva) → crece rápido. La
  -- limpieza diaria borra por created_at solo (DELETE ... WHERE created_at < -60 días); los
  -- índices de arriba arrancan por source/chat_id, que no cubren ese rango → este sí.
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_reminders_pending ON reminders(status, due_at);
  CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
  CREATE INDEX IF NOT EXISTS idx_group_context_created ON group_context(created_at);
  CREATE INDEX IF NOT EXISTS idx_calendly_pushes_due ON calendly_pushes(status, due_at);
  CREATE INDEX IF NOT EXISTS idx_outreach_active ON outreach_schedules(active, status);
`);

console.log('✅ Base de datos lista en', DB_PATH);
db.close();
