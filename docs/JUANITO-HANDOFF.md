# JUANITO — Hand-off completo

Documento vivo: todo lo que alguien necesita saber para entender, mantener o
continuar el desarrollo de Juanito. Actualizar cada vez que haya un cambio relevante.

Última actualización: 2026-06-08

---

## Qué es Juanito

Juanito es un agente de IA personal conectado a WhatsApp. Escucha los grupos del
jefe de forma pasiva, responde cuando lo mencionan con @Juanito, y atiende DMs del
jefe y el equipo técnico. Vive en un VPS de DigitalOcean con IP fija, conectado
via Baileys (protocolo WhatsApp Web).

**No es un chatbot público.** Es un asistente privado con acceso controlado:
solo el jefe y los admins configurados reciben respuestas de Claude. El resto
de personas que le escriban son ignoradas o reciben una respuesta genérica de
opt-in (solo si son closers registrados del sistema Calendly).

---

## Arquitectura en tiempo de ejecución

```
Baileys (WebSocket persistente a WhatsApp)
    │  messages.upsert event
    ▼
src/whatsapp/index.js       ← detecta @mention via LID/JID, resuelve LIDs, guarda mensajes de grupo
    │  onMessage({ chatId, isGroup, text, sender, isBotMentioned, pushName, ... })
    ▼
src/index.js                ← determina rol del remitente
    ├── /comando            → src/bot/commands.js       → respuesta determinista (sin Claude)
    ├── DM de BOSS/ADMIN    → src/bot/index.js          → Claude → sendMessage(sender, reply)
    ├── DM de desconocido   → src/calendly/optin.js     → registra opt-in, respuesta genérica
    └── Grupo               → src/bot/index.js          → si @mention + rate limit OK → Claude → sendMessage(chatId, reply)

src/scheduler/              ← jobs independientes del flujo de mensajes
    ├── reminders.js        → cada 1 minuto: envía recordatorios vencidos
    ├── summaries.js        → cada 4 horas: resume grupos y guarda en DB
    └── index.js            → arranca todos los jobs
```

**Stack técnico:**
- Runtime: Node.js ESM, sin transpilador
- WhatsApp: `@whiskeysockets/baileys` v7 RC (protocolo nativo, sin Meta API)
- IA: `@anthropic-ai/sdk` — Claude con tool use
- DB: `better-sqlite3` — SQLite en `/app/data/brain.sqlite`
- Scheduler: `cron`
- Infra: Docker + `entrypoint.sh` con backoff exponencial

---

## Sistema de roles

Definido en `src/common/roles.js`. Cada mensaje entrante es clasificado antes de
cualquier otra lógica.

| Rol | Cómo se identifica | Acceso |
|-----|--------------------|--------|
| `admin` | LID en `ADMIN_LID` (env var, coma-separado) | Máximo: todas las tools, diagnósticos del sistema |
| `boss` | Teléfono coincide con `BOSS_PHONE` **o** LID coincide con `BOSS_LID` | Privilegiado: Claude responde, tools acotadas (no puede escribir memoria núcleo) |
| `unknown` | Cualquier otro número | Sin acceso a Claude. Solo opt-in Calendly si es un closer registrado. |

**Regla de prioridad:** si un LID aparece en `ADMIN_LID`, es admin aunque también
coincida con `BOSS_LID`.

**Retrocompatibilidad:** si `BOSS_LID` no está configurado, cualquier `@lid` no
resuelto se trata como jefe. En producción `BOSS_LID` siempre debe estar seteado
para evitar que closers con LID desconocido accedan como jefe.

**Cómo obtener el LID de un número:** el usuario le escribe `/whoami` a Juanito
y Juanito responde con su JID. Si es un LID (`@lid`), ese es el valor a agregar
en `ADMIN_LID` o `BOSS_LID`.

---

## Comportamiento en DMs

```
DM entrante
    │
    ├── /whoami, /id      → "Tu ID: <jid>  Rol: <rol>"             (cualquier remitente)
    ├── /status           → diagnóstico del sistema                 (solo admin)
    │   └── no admin      → "Ese comando es solo para el equipo técnico 🙂"
    │
    ├── rol admin/boss    → Claude responde (con tools según rol)
    └── rol unknown       → si es closer conocido: confirma opt-in + respuesta genérica
                            si no es closer: silencio total
```

---

## Comportamiento en grupos

Juanito escucha **todos** los mensajes de grupos de forma pasiva y los guarda en
SQLite (`messages` con `source='group'`). Solo responde cuando:

1. El mensaje contiene una `@mention` real al bot (función nativa de WA).
   Texto como *"Juanito, ayúdame"* sin @mention **no** dispara respuesta.
2. El remitente no superó el rate limit del día.

**En grupos Juanito es chatbot puro:** ninguna herramienta disponible. No puede
leer ni escribir memoria, no crea recordatorios, no resume grupos, no consulta
historial. Esto es intencional — protege la privacidad del jefe ante cualquier
usuario de un grupo.

### Rate limit en grupos

| Remitente | Límite diario |
|-----------|:------------:|
| `BOSS_PHONE` | Ilimitado |
| `UNLIMITED_PHONES` (env var) | Ilimitado |
| Cualquier otro | `GROUP_DAILY_LIMIT` (default: 5) |

El contador se resetea cada día. Los registros de más de 7 días se limpian
automáticamente a las 3am.

---

## Personalidad de Juanito

System prompt construido dinámicamente en `src/claude/index.js → buildSystemPrompt()`.

- **Nombre:** Juanito (configurable via `BOT_NAME`). Sabe su nombre y lo dice si preguntan.
- **Tono:** Alegre y con buena energía. Muy respetuoso y atento con todos.
  Genuinamente útil — menciona cosas proactivamente.
- **Idioma:** Responde en el mismo idioma que le escriben.
- **Nombre del jefe:** Si `BOSS_NAME` está en el `.env`, Juanito lo usa al saludar.
  El jefe también puede configurarlo via DM: *"recuerda que me llamo Juan"* →
  Juanito lo guarda con `remember_note` y lo usa desde ese momento.

El system prompt incluye en cada llamada:
- Fecha y hora actual (zona `TZ`)
- Bloque de personalidad y nombre del bot
- Nombre del jefe (si configurado)
- Reglas de seguridad innegociables
- Bloque de rol del interlocutor (admin vs jefe vs grupo)
- Memoria núcleo (hechos permanentes guardados por admins)
- Notas personales del jefe (sandboxed)
- Resúmenes recientes de grupos (últimos 5)
- Recordatorios próximos (próximas 48 horas)

---

## Herramientas de Claude (tool use)

Las tools se gatean a nivel de API — lo que no está en el array, Claude no puede
invocar pase lo que pase.

| Tool | Admin | Boss | Grupo | Qué hace |
|------|:-----:|:----:|:-----:|---------|
| `create_reminder` | ✅ | ✅ | ❌ | Crea recordatorio con fecha/hora y destinatario opcional |
| `save_memory` | ✅ | ❌ | ❌ | Escribe en la memoria núcleo del sistema (key/value) |
| `remember_note` | ✅ | ✅ | ❌ | Guarda nota personal del jefe (sandboxed, no afecta comportamiento) |
| `summarize_group` | ✅ | ✅ | ❌ | Lee y resume un grupo por nombre |
| `search_knowledge` | ✅ | ✅ | ❌ | Busca en historial, memoria núcleo y resúmenes de grupos |

**Por qué el jefe no puede usar `save_memory`:** la memoria núcleo alimenta el
comportamiento del bot para todos. Solo el equipo técnico (admins) debe modificarla.
El jefe tiene `remember_note` para sus notas personales, que quedan aisladas.

---

## Memoria

### Memoria núcleo (admin)
- Tabla: `memory(key, value)`
- Solo admins pueden escribirla (`save_memory`).
- Se inyecta completa en el system prompt de cada conversación (DM del jefe o admin).
- Uso típico: hechos del negocio, contexto del jefe, personas clave, proyectos activos.

### Notas del jefe (sandboxed)
- Misma tabla `memory`, keys con prefijo `boss_note:`.
- El jefe escribe con `remember_note`.
- Se inyectan en el prompt como **datos** con aviso explícito de que no son
  instrucciones y no cambian las reglas del bot.
- El jefe no puede tocar la memoria núcleo.

### Cómo consultar la memoria desde el VPS
```bash
# Memoria núcleo (admins)
docker exec juanito-agent sqlite3 /app/data/brain.sqlite \
  "SELECT key, value FROM memory WHERE key NOT LIKE 'boss_note:%';"

# Notas del jefe
docker exec juanito-agent sqlite3 /app/data/brain.sqlite \
  "SELECT key, value FROM memory WHERE key LIKE 'boss_note:%';"
```

---

## Recordatorios

El jefe o un admin dicen: *"recuérdame mañana a las 9 llamar a Pedro"*. Juanito
usa `create_reminder` → guarda en tabla `reminders`. El scheduler corre cada
minuto y envía los vencidos.

- Destinatario: el jefe por defecto, o un contacto de la tabla `contacts`.
- Timezone: usa JS `Date` con `TZ` explícito (Alpine Linux no tiene tzdata — SQLite
  `localtime` devuelve UTC, por eso no se usa).

### Cómo consultar recordatorios desde el VPS
```bash
# Todos los recordatorios
docker exec juanito-agent sqlite3 /app/data/brain.sqlite \
  "SELECT id, text, due_at, to_phone, status FROM reminders ORDER BY due_at DESC LIMIT 20;"

# Solo pendientes
docker exec juanito-agent sqlite3 /app/data/brain.sqlite \
  "SELECT id, text, due_at FROM reminders WHERE status='pending' ORDER BY due_at;"
```

---

## Resúmenes automáticos de grupos

- Cada 4 horas (`SUMMARY_CRON`), el scheduler lee los últimos 50 mensajes de cada
  grupo y le pide a Claude un resumen.
- Se guarda en `group_context`.
- Los últimos 5 resúmenes se inyectan en el system prompt del jefe.
- Máx `MAX_GROUPS_PER_CYCLE` grupos por ciclo (default: 10).

---

## Calendly y closers

Sistema de recordatorios precall para el equipo de ventas.

- **Anti-baneo:** Juanito nunca inicia conversación con un closer. Solo responde
  si el closer le escribió primero → queda registrado en `calendly_optins`.
- **Pushes precall:** Push 1 (noche anterior), Push 2 (mañana del día), Push 3
  (~25 min antes de la llamada).
- **DRY_RUN=true** por defecto → no envía nada, solo loguea. Poner `false` para
  activar envío real.

---

## Configuración — Variables de entorno

| Variable | Requerida | Default | Descripción |
|----------|:---------:|---------|-------------|
| `ANTHROPIC_API_KEY` | ✅ | — | API key de Anthropic |
| `BOSS_PHONE` | ✅ | — | Teléfono del jefe sin `+` (ej: `573105643297`) |
| `BOSS_LID` | ✅ prod | — | LID del jefe (ej: `144268136038585@lid`). Obtenerlo de los logs al arrancar o con `/whoami`. |
| `ADMIN_LID` | ✅ prod | — | LIDs del equipo técnico, coma-separados. Obtenerlos con `/whoami`. |
| `BOT_NAME` | — | `Juanito` | Nombre del bot en el system prompt |
| `BOSS_NAME` | — | — | Nombre del jefe. Juanito lo usa al saludar. También configurable via DM con `remember_note`. |
| `CLAUDE_MODEL` | — | `claude-sonnet-4-20250514` | Modelo de Claude |
| `CLAUDE_MAX_TOKENS` | — | `2048` | Máx tokens en respuesta |
| `DB_PATH` | — | `./data/brain.sqlite` | Ruta de la base de datos |
| `WA_SESSION_PATH` | — | `./data/wa-session` | Sesión de Baileys |
| `TZ` | — | `America/Bogota` | Zona horaria para recordatorios y scheduler |
| `GROUP_DAILY_LIMIT` | — | `5` | Menciones máximas por usuario/día en grupos |
| `UNLIMITED_PHONES` | — | — | Teléfonos sin rate limit en grupos (coma-separados) |
| `SUMMARY_CRON` | — | `0 */4 * * *` | Frecuencia de resúmenes de grupos |
| `SUMMARY_CYCLE_HOURS` | — | `4` | Ventana de mensajes por resumen |
| `MAX_GROUPS_PER_CYCLE` | — | `10` | Máx grupos resumidos por ciclo |
| `CALENDLY_TOKEN` | — | — | Personal Access Token de Calendly |
| `CALENDLY_DRY_RUN` | — | `true` | `true` = no envía WhatsApp, solo loguea |
| `CALENDLY_REQUIRE_OPTIN` | — | `true` | `true` = solo envía a closers con opt-in previo |

---

## Infraestructura VPS

- **Proveedor:** DigitalOcean SFO2, IP fija (crítica — no migrar sin planearlo)
- **SSH:** `root@157.230.152.202`
- **Directorio del proyecto:** `/root/juanito/`
- **Container:** `juanito-agent`
- **Datos persistentes:** `/root/juanito/data/` → montado en `/app/data/`
- **Sesión WA:** `/root/juanito/data/wa-session/`
- **DB:** `/root/juanito/data/brain.sqlite`

**Nota:** el VPS no tiene git (`git clone` nunca se hizo). Los cambios de código
se copian con `scp` y se reconstruye la imagen.

### Comandos de operación

```bash
# Ver estado del container
docker ps | grep juanito

# Logs en tiempo real
docker logs juanito-agent -f 2>&1

# Copiar archivo modificado y reconstruir (SIEMPRE usar --build)
scp src/bot/index.js root@157.230.152.202:/root/juanito/src/bot/index.js
ssh root@157.230.152.202 "cd /root/juanito && docker compose up -d --build"

# Consultar la DB directamente
docker exec juanito-agent sqlite3 /app/data/brain.sqlite "<query SQL>"
```

### Reglas críticas de operación

**Actualización de código:** el `docker-compose.yml` no tiene volume mount para
el código. Cada cambio requiere `docker compose up -d --build`. `docker restart`
no aplica cambios de código.

**Backoff exponencial:** `entrypoint.sh` tiene backoff 30→60→120→240→300s entre
reinicios. No tocar. Un softban previo fue causado por reconexiones rápidas desde
IP de datacenter — WhatsApp lo detecta y bloquea el número.

**Vinculación de WhatsApp:** nunca escanear el QR desde el VPS. Ver
`docs/WHATSAPP-PAIRING.md`. El flujo es: vincular desde IP residencial local →
copiar `data/wa-session/` al VPS → arrancar el container.

---

## Base de datos — Tablas

| Tabla | Qué guarda |
|-------|-----------|
| `messages` | Historial de conversaciones (DMs y grupos). Últimos 20 incluidos en cada llamada a Claude. |
| `memory` | Memoria clave-valor de largo plazo. Prefijo `boss_note:` = notas personales del jefe (sandboxed). |
| `reminders` | Recordatorios con fecha, destinatario y estado (`pending/sent/failed`). |
| `group_context` | Resúmenes periódicos de grupos. Últimos 5 inyectados en el prompt. |
| `contacts` | Directorio nombre → teléfono. Para resolver destinatarios de recordatorios. |
| `processed_messages` | IDs procesados (deduplicación — evita procesar el mismo mensaje dos veces). |
| `calendly_pushes` | Agenda de recordatorios precall para closers. |
| `calendly_optins` | Closers con opt-in (escribieron a Juanito al menos una vez). |
| `group_usage` | Contadores diarios de menciones por usuario en grupos (rate limit). |

---

## Modelo de seguridad

| Amenaza | Mitigación |
|---------|-----------|
| Usuario de grupo accede a datos del jefe | Tools completamente deshabilitadas en grupos — chatbot puro sin acceso a datos |
| Desconocido accede a Claude via DM | Solo BOSS/ADMIN llegan a Claude; el resto va a opt-in handler o silencio |
| El jefe modifica comportamiento del bot | `save_memory` bloqueado para boss; `remember_note` va a namespace sandboxed, inyectado como datos no como instrucciones |
| Prompt injection en grupos | Sin tools, sin historial de conversaciones expuesto en grupos |
| Revelación de config interna | System prompt prohíbe explícitamente revelar tokens, env vars, LIDs, teléfonos de terceros |
| Softban por reconexiones rápidas | Backoff exponencial en `entrypoint.sh`; container no expone puertos |
| Procesamiento duplicado | Tabla `processed_messages` deduplica por `message_id` |

---

## Estado de pruebas — sesión 2026-06-08

### ✅ Pasaron / Resueltos

| # | Prueba | Nota |
|---|--------|------|
| A1–A2 | Juanito sabe su nombre | Fix en system prompt |
| A4–A5 | No revela config interna | Pasa |
| B1–B4 | DMs por autorización | Pasa |
| C1–C4 | Roles y comandos | Pasa |
| C5 | /status para no-admin | Fix: responde "solo para equipo técnico 🙂" |
| D1–D4 | Memoria por rol | Pasa |
| D5 | Grupos no guardan datos ajenos | **Decisión:** grupos sin ningún tool — chatbot puro. Nadie puede crear recordatorios ni escribir en la DB desde un grupo. |
| E1–E3 | @mention en grupos | Pasa |
| E6 | Memoria no se revela en grupos | Fix: `search_knowledge` eliminado de grupos |
| F1–F3 | Recordatorios | Pasa |

### ⚠️ Parcialmente resuelto

| # | Prueba | Estado |
|---|--------|--------|
| A3 | Juanito saluda al jefe por nombre | Infraestructura lista (`BOSS_NAME` en `.env` o via `remember_note`). Falta que el jefe configure su nombre: debe escribirle a Juanito "recuerda que me llamo [nombre]" |

### ⏳ Pendientes de ejecutar — críticos antes de entregar al jefe

| # | Prueba | Cómo ejecutarla |
|---|--------|----------------|
| E4 | Rate limit se reinicia al día siguiente | Agotar los 5 mensajes un día; al día siguiente @mencionar → debe responder |
| E5 | BOSS es ilimitado en grupos | Con el número del BOSS, @mencionar más de 5 veces en un grupo → debe responder todas |
| G1 | Container restart recupera la sesión | `docker restart juanito-agent` → debe reconectar sin pedir QR |
| G3 | Deduplicación de mensajes | Enviar el mismo mensaje dos veces exacto → solo debe responder una vez |
| G4 | Mensaje sin texto (sticker/imagen) | BOSS envía sticker o imagen → debe ignorar sin error |

### ⏳ Pendientes — recomendados

| # | Prueba | Cómo ejecutarla |
|---|--------|----------------|
| G2 | Mensaje muy largo | Enviar más de 1000 caracteres → debe responder sin crashear |
| G5 | Error de API de Claude | Configurar `ANTHROPIC_API_KEY` inválida temporalmente → debe responder mensaje amigable al jefe, no crashear el proceso |

---

## Features pendientes — por prioridad

### 🔴 Alta prioridad

**Memoria específica por grupo**
Hoy Juanito responde en grupos como chatbot genérico sin saber nada del grupo.
Permitir que un admin asigne contexto a un grupo concreto ("en el grupo Ventas,
el producto es X, el equipo son Y y Z, el objetivo mensual es W").

Implementación:
- Nueva tabla: `group_memory(group_id TEXT PRIMARY KEY, context TEXT, updated_at)`
- Nuevos tools para admin/boss: `set_group_context(group_id, context)`, `get_group_context(group_id)`
- En `buildSystemPrompt()` (`src/claude/index.js`): si `isGroup=true` y existe
  entrada para `chatId`, inyectarla como bloque `## Contexto de este grupo`
- Archivos: `src/db/migrate.js`, `src/db/index.js`, `src/claude/index.js`, `src/bot/index.js`

---

### 🟡 Media prioridad

**Juanito saluda a los ADMINs por nombre**
El jefe configura su nombre via `remember_note` y Juanito lo usa. Para admins no
existe esa memoria personal. Implementar `admin_note:<lid>:<key>` análoga a las
notas del jefe.
Archivos: `src/claude/index.js`

**Comando `/admins` para listar admins activos**
Desde un DM de admin, listar LIDs en `ADMIN_LID` con su nombre de contacto si
está en la tabla `contacts`. Útil para auditar accesos.
Archivos: `src/bot/commands.js`

**Capturar LID del jefe automáticamente**
Hoy `BOSS_LID` se configura manualmente. Cuando el jefe manda el primer DM
reconocido por `BOSS_PHONE`, guardar su LID en DB automáticamente.

**Rate limit configurable por grupo**
Hoy `GROUP_DAILY_LIMIT` es global. Configurar por grupo.

---

### 🟢 Baja prioridad / Nice-to-have

**Comando `/recuerda` en grupos (para admins)**
`@Juanito /recuerda [texto]` desde un grupo → guarda en memoria núcleo sin
necesidad de ir a un DM.

**Resumen on-demand explícito**
El tool `summarize_group` ya existe, pero no se menciona en el prompt del jefe.
Exponer la opción explícitamente.

**Personalización del tono por grupo**
Tono formal en grupos de clientes, informal en grupos internos.
Configurable junto con `set_group_context` (feature de alta prioridad).
