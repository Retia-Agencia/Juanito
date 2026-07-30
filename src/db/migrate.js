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
  -- push_n: 0 (aviso nueva call) | 1/2 (digests) | 3 (precall 25min antes) |
  --         4 (POST-call: pide el outcome — §18.AB). El 4 invierte el guard de
  --         obsolescencia: se entrega DESPUÉS de la call, no antes.
  CREATE TABLE IF NOT EXISTS calendly_pushes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    event_uuid     TEXT NOT NULL,
    push_n         INTEGER NOT NULL DEFAULT 3,
    program        TEXT,                            -- second_brain | abogados | linkedin | developers | operaciones (§18.AB)
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

  -- Outcomes de calls reportados por el closer (§18.AB). FUENTE DE VERDAD del
  -- registro de calls: lo que el closer confirmó por WhatsApp apenas colgó, no lo
  -- que se acordó de anotar en una hoja. Separa por programa y por closer (pedido
  -- del owner). Una fila por call (event_uuid UNIQUE).
  --   status: pending       → se preguntó, falta respuesta
  --           awaiting_date → dijo "reagendó", falta la fecha de la nueva call (§18.AC)
  --           answered      → el closer respondió (asistencia [+ resultado / fecha])
  --           no_answer     → no respondió tras insistir (queda "sin registrar")
  --           auto          → lo derivó el sistema sin preguntar (ej: cita cancelada)
  CREATE TABLE IF NOT EXISTS call_outcomes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_uuid   TEXT NOT NULL UNIQUE,
    program      TEXT,                       -- second_brain | abogados | linkedin | developers | operaciones
    closer_email TEXT,
    closer_phone TEXT,                       -- número canónico (clave del opt-in)
    closer_name  TEXT,
    lead_name    TEXT,
    lead_phone   TEXT,
    call_start   TEXT NOT NULL,              -- 'YYYY-MM-DD HH:MM:SS' UTC
    asistencia   TEXT,                       -- show | no_show | reagendado | cancelado
    resultado    TEXT,                       -- venta_cerrada | acuerdo_verbal | seguimiento | no_cerro | NULL
    status       TEXT NOT NULL DEFAULT 'pending',
    asked_at     DATETIME,                   -- cuándo se le preguntó al closer
    answered_at  DATETIME,
    reminded     INTEGER NOT NULL DEFAULT 0, -- 1 = ya se insistió una vez (cumplimiento v1)
    raw_reply    TEXT,                        -- texto crudo del closer (auditoría)
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
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

// §18.AB: programa de la cita en el push (para no re-consultar Calendly al reportar).
// Filas viejas quedan NULL (eran Push 0/3, no se reportan como outcome).
addColumnIfMissing('calendly_pushes', 'program', 'TEXT');

// §18.AO: por qué se saltó una fila. Hasta ahora el motivo solo vivía concatenado al `message`,
// que sirve para leer un log pero no para consultar. Se necesita consultable porque la agenda
// del jefe arma sus calls uniendo Calendly + meetings CRUDOS de HubSpot, y el meeting de una
// call reagendada dentro del CRM sigue ahí con su hora vieja: sin poder preguntar "¿esta call se
// movió?" el reporte listaría una llamada que Juanito ya sabe que no va a ocurrir.
// Valores: 'rescheduled' (se movió en el CRM) | NULL (todo lo demás, incluido lo ya existente).
addColumnIfMissing('calendly_pushes', 'skip_reason', 'TEXT');

// §18.AC: reagendas. Cuando el closer marca "Reagendó", Juanito le pregunta la fecha y
// agenda por su cuenta la call nueva (Push 3 + Push 4 con un event_uuid sintético
// 'manual:<uuid>:<n>'), venga o no de Calendly. Sobreviven solo los 2 campos que SON
// métrica; el estado temporal vive en calendly_pushes y lo purga la limpieza diaria.
addColumnIfMissing('call_outcomes', 'rescheduled_to', 'TEXT');      // 'YYYY-MM-DD HH:MM:SS' UTC | NULL = sin fecha
addColumnIfMissing('call_outcomes', 'reschedule_uuid', 'TEXT');     // event_uuid de la call generada
addColumnIfMissing('call_outcomes', 'reschedule_asked', 'INTEGER NOT NULL DEFAULT 0'); // veces que se pidió la fecha
// Última vez que Juanito preguntó ALGO de esta fila. Ancla la ventana de frescura de
// getActiveOutcomeForCloser: una fila a medio flujo solo se lleva la respuesta del closer
// si se le preguntó hace poco (si no, una reagenda sin fecha de ayer secuestraría el
// Push 4 de hoy). Filas viejas quedan NULL → caen al FIFO por asked_at, como antes.
addColumnIfMissing('call_outcomes', 'prompted_at', 'DATETIME');

// Mensajes programados GENERADOS (§18.E fase aprobación): kind 'fixed' (texto exacto,
// comportamiento original) | 'generated' (Claude redacta cada día según `brief` y se
// publica solo tras aprobación del jefe).
addColumnIfMissing('scheduled_messages', 'kind', "TEXT NOT NULL DEFAULT 'fixed'");
addColumnIfMissing('scheduled_messages', 'brief', 'TEXT');

// Nombre de QUIEN ordena el outreach (jefe o admin) → el mensaje al tercero va "de parte de"
// esa persona, no siempre del jefe. Se resuelve al crear (BOSS_NAME para el jefe, pushName para
// admins, o un from_name explícito) y se guarda porque la entrega es asíncrona. Ver §18.Y.
addColumnIfMissing('outreach_schedules', 'sender_name', 'TEXT');

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

// ─── 3. Registries (F3a — docs/DASHBOARD-ROADMAP.md) ─────────────────────────
//
// Espejo en DB de los registros que hoy viven como literales en src/calendly/
// {programs,accounts,closers}.js. **En F3a NADIE LEE ESTAS TABLAS**: el runtime sigue leyendo
// del código, y los flags REGISTRY_SOURCE_* de F3c arrancan en 'code'. Existen desde ya para
// que el día que se cambie la fuente no haya ADEMÁS una migración en el camino crítico.
//
// Tres cosas que valen la pena saber antes de tocarlas:
//   · `sort_order` NO es cosmético. Los literales son objetos y el código itera en orden de
//     inserción: `programFromTitle` devuelve el PRIMER programa cuyo hint matchea el título.
//     Sin preservar el orden, un título ambiguo puede clasificarse a otro programa.
//   · Los SECRETOS no viven acá. De cada Conexión se guarda el NOMBRE de su env var
//     (`token_env`), nunca el token. La base es un archivo que se copia a /tmp para correr
//     selftests; un token adentro se filtraría en cada copia.
//   · `materials` va como JSON y no normalizado en columnas: sus llaves son heterogéneas
//     (brochure, video, order, sendLinks, boldHeader) y crecen por programa. buildPrecallText
//     lo consume entero, así que el blob es la representación fiel.
db.exec(`
  -- Empresas: marca de cara al lead. Hoy es solo un label (ADR 0001).
  CREATE TABLE IF NOT EXISTS companies (
    key        TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  -- Conexiones de Calendly (el código las llama ACCOUNTS por historia).
  -- Los *_env guardan el NOMBRE de la variable, no su valor.
  -- Convención de los defaults booleanos: 1 = la env APAGA con 'false';
  --                                       0 = la env PRENDE con 'true'.
  -- Con *_env NULL el valor es fijo y no se puede mover por entorno (ej: push4 de retia).
  CREATE TABLE IF NOT EXISTS connections (
    key             TEXT PRIMARY KEY,
    label           TEXT NOT NULL,
    token_env       TEXT NOT NULL,
    org_uri_env     TEXT,
    org_uri_default TEXT NOT NULL,
    dry_run_env     TEXT,
    dry_run_default INTEGER NOT NULL DEFAULT 1,
    push4_env       TEXT,
    push4_default   INTEGER NOT NULL DEFAULT 1,
    hubspot         INTEGER NOT NULL DEFAULT 0,
    sheets          TEXT,                        -- JSON [{label,url}] | NULL = sin Push 5
    sort_order      INTEGER NOT NULL DEFAULT 0
  );

  -- Programas. Fuente única de label + empresa + conexión + event_type + copy.
  CREATE TABLE IF NOT EXISTS programs (
    key           TEXT PRIMARY KEY,
    label         TEXT NOT NULL,
    title_hints   TEXT,                          -- JSON [string] | NULL = cae al label
    company       TEXT NOT NULL,
    connection    TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    pitch_from    TEXT NOT NULL,
    pitch_program TEXT NOT NULL,
    materials     TEXT,                          -- JSON {brochure?,video?,order?,...}
    active        INTEGER NOT NULL DEFAULT 1,
    sort_order    INTEGER NOT NULL DEFAULT 0
  );

  -- Closers: la PERSONA es la unidad de autoría. Una persona cierra para 1+ Conexiones.
  CREATE TABLE IF NOT EXISTS closers (
    key        TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  -- Identidades: una por (persona, Conexión). email es la llave con la que el resto del
  -- código resuelve todo (CLOSERS va keyeado por email), de ahí el UNIQUE.
  -- ⚠️ Dos identidades PUEDEN compartir teléfono si son la MISMA persona (Sebastian Salazar,
  -- 30x + retia desde una línea). Lo que rompería la DB es dos PERSONAS con un teléfono:
  -- se pisarían el opt-in. Esa invariante la cuida el test, no el esquema.
  CREATE TABLE IF NOT EXISTS closer_identities (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    closer_key    TEXT NOT NULL,
    connection    TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    phone         TEXT NOT NULL,
    work_lid      TEXT,                          -- LID de TRABAJO; nunca uno personal
    hubspot_email TEXT,                          -- alias de owner en HubSpot, si difiere
    sort_order    INTEGER NOT NULL DEFAULT 0
  );

  -- Hosts que aparecen en el query org-wide y se saltan EN SILENCIO (sin alerta de
  -- "closer sin mapear"). El silencio es justo lo que hizo invisible al §18.AV: tenerlos en
  -- una tabla los vuelve auditables desde el dashboard en vez de enterrados en un Set.
  CREATE TABLE IF NOT EXISTS ignored_closers (
    email      TEXT PRIMARY KEY,
    note       TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
`);

// El seed corre SOLO sobre tablas vacías y vive aparte (importa src/calendly/*.js para no
// duplicar los literales). Va envuelto porque `entrypoint.sh` es
// `node src/db/migrate.js && node src/index.js`: una excepción acá deja al bot SIN ARRANCAR.
// En F3a nadie lee estas tablas, así que un seed fallido no tiene ninguna consecuencia
// operativa — tumbar WhatsApp por él sería el peor negocio posible. Grita en el log y sigue.
// ⚠️ Cuando F3c encienda la lectura desde DB, este try/catch deja de ser suficiente por sí
// solo: la garantía pasa a ser el flag REGISTRY_SOURCE_* (default 'code') + el test de
// equivalencia, no el seed.
try {
  // `await import` y no un `import` estático arriba: un import estático que falle (un error de
  // sintaxis en el seed o en cualquier módulo de src/calendly/) revienta al CARGAR el módulo,
  // antes de que este try/catch exista. El dinámico mete también ese caso adentro de la red.
  const { seedRegistries } = await import('./registry-seed.js');
  const resumen = seedRegistries(db);
  const sembradas = Object.entries(resumen).filter(([, n]) => n > 0);
  if (sembradas.length) {
    console.log('  + registries sembrados:', sembradas.map(([t, n]) => `${t}=${n}`).join(' '));
  }
} catch (e) {
  console.error('⚠️  seed de registries falló (no bloquea el arranque; nadie los lee en F3a):', e.message);
}

// ─── 4. Índices ───────────────────────────────────────────────────────────────

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
  -- §18.AB: outcomes pendientes por closer (captura de respuesta) + insistencia por asked_at.
  CREATE INDEX IF NOT EXISTS idx_call_outcomes_pending ON call_outcomes(status, closer_phone, asked_at);
  CREATE INDEX IF NOT EXISTS idx_call_outcomes_program ON call_outcomes(program, call_start);
`);

console.log('✅ Base de datos lista en', DB_PATH);
db.close();
