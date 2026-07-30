# CLAUDE.md — Guía del repo Juanito

> **Estado vivo del proyecto → [docs/JUANITO-HANDOFF.md](docs/JUANITO-HANDOFF.md)** (fuente de
> verdad: features, decisiones y pendientes en §18). Este archivo es guía de manejo del repo,
> no documentación — mantenerlo esencial y conciso.
>
> **Dashboard centralizado (en construcción) → [docs/DASHBOARD-ROADMAP.md](docs/DASHBOARD-ROADMAP.md)**
> — fases, tareas e interruptores. Decisión arquitectónica en
> [ADR 0002](docs/adr/0002-dashboard-y-superficie-http.md).

## Qué es esto

Agente IA personal ("Juanito") conectado al WhatsApp del jefe via Baileys.
Escucha grupos pasivamente, responde cuando lo mencionan, y atiende DMs del jefe.
Vive en un VPS de DigitalOcean con IP fija (crítica para WA).

## Stack

- **Runtime:** Node.js ESM, sin transpilador
- **WhatsApp:** `@whiskeysockets/baileys` embebido directamente (no OpenWA, no Meta API)
- **IA:** `@anthropic-ai/sdk` — Claude con tool use (SDK en v0.27.0)
- **DB:** `better-sqlite3` — SQLite (mensajes, memoria, recordatorios, grupos, contactos)
- **Scheduler:** `cron` — varios jobs (ver sección Scheduler)
- **Infra:** Docker + `entrypoint.sh` con backoff exponencial

## Arquitectura en runtime

```
Baileys (WebSocket saliente a WA)
    │ messages.upsert
    ▼
src/index.js → src/bot/index.js  (router: dedup + autorización por rol)
    ├── DM jefe/admin → handleBossMessage → claude/index.js (memoria + tools)
    ├── Grupo         → handleGroupMessage → si mención → prompt AISLADO por chat_id
    │                    │                     → cola de aprobación del jefe
    │                    └── siempre persiste en SQLite (lectura pasiva)
    └── Comando /…    → src/bot/commands.js

Schedulers (cron) ───┐
Todo lo demás ───────┴─▶ src/whatsapp/send-queue.js (cola FIFO anti-ban) ─▶ WA
```

Regla clave: **todo envío sale del proceso principal y pasa por la cola anti-ban**.

**Segundo contenedor: `juanito-dash`** (solo lectura). Lee el MISMO SQLite desde otro proceso e
importa `src/db/index.js` y `src/calendly/*.js` en vez de reimplementarlos. Va aparte del bot por el
crash domain, no por recursos. Para alertar por WhatsApp **no tiene socket**: inserta en la tabla
`reminders`, que el cron del bot despacha por la cola anti-ban — la regla de arriba se mantiene.

## Archivos clave

| Ruta | Rol |
|---|---|
| `src/index.js` | Entry point: wira Baileys → bot |
| `dashboard/` | Consola de operación (contenedor `dash`). `server/` = API `node:http` de lectura + watchdog; `src/` = SPA Vite/React; `server/selftest.js` ejercita toda la capa de lectura contra una copia de la DB. Guía: [docs/DASHBOARD-ROADMAP.md](docs/DASHBOARD-ROADMAP.md) |
| `src/bot/` | Router (`index.js`), comandos (`commands.js`), guard anti-secuestro de grupos (`group-guard.js`) |
| `src/claude/index.js` | Claude: prompts, tool-use loop, memoria, reintentos |
| `src/whatsapp/` | Baileys (`index.js`), cola anti-ban (`send-queue.js`), cache de subjects |
| `src/common/roles.js` | Resolución de rol por LID (jefe / admin / closer) |
| `src/scheduler/` | Cron jobs — `index.js` los arranca y lista todos |
| `src/calendly/` | Recordatorios precall a closers. **`programs.js`** = registro `PROGRAMS` de primera clase (label, company, connection, eventType, pitch, materiales) — fuente única de la que se derivan los mapas de copy/ET. **`accounts.js`** = registro de **conexiones de Calendly** (token, org, dry-run; los eventTypes se derivan de `programs.js`). **`closers.js`** = roster keyeado por **persona con identidades** (una por conexión); deriva `CLOSERS`/`CLOSER_LIDS`. Modelo empresa/programa/closer: [ADR 0001](docs/adr/0001-modelo-empresa-programa-closer.md) + glosario [docs/agents/context.md](docs/agents/context.md). |
| `src/sheets/` | Reporte diario de leads desde Google Sheets |
| `src/db/` | SQLite: operaciones (`index.js`) + migración idempotente (`migrate.js`) |
| `entrypoint.sh` | Backoff exponencial entre crashes (softban) |

## Scheduler

Cron jobs centralizados en `src/scheduler/index.js` (`startAllJobs()`) — ahí está el listado
completo con horarios. Cada job **se autodesactiva si le falta su token/destino**, para no romper
el arranque. Cubren: recordatorios, limpieza diaria, resúmenes de grupos, Calendly (Push 0-3),
reporte de Sheets, mensajes recurrentes a grupos, mensajes a terceros por orden del jefe
(`schedule_outreach`) y respuestas con aprobación.

## Sistema de roles

Juanito identifica a cada contacto por su **LID** de WhatsApp (no por número), resuelto en
`src/common/roles.js`: **jefe** (Dani), **admin**, **closer** o desconocido. El rol define qué
puede hacer (memoria, comandos admin, rate-limit) y qué prompt se usa. Existe swap de roles para
pruebas. Detalle en §3 del handoff.

## Comandos (DM admin)

`/confirmaciones [dm|grupo …] on|off` · `/calendly on|off [closer] [cuenta|todo]` · `/grupos` ·
`/reporte(s)` · `/persona <grupo> | <texto>` · `/programados` · `/aprobaciones` · `/respuestas` ·
`/status` · `/whoami` · `/id` — manual completo en [docs/MANUAL-DE-USO.md](docs/MANUAL-DE-USO.md).

## Variables de entorno

Fuente de verdad: `.env.example`. Críticas: `ANTHROPIC_API_KEY`, `BOSS_PHONE` (sin +),
`BOT_NAME`, `TZ`. El resto (modelos por contexto, Calendly, Sheets/`GOOGLE_SA_KEY`, resúmenes,
hardening) tiene default seguro.

## Estado del VPS (DigitalOcean SFO2, IP fija)

- Docker instalado y corriendo; este repo se despliega aquí
- La IP fija es crítica — no migrar sin planificarlo
- Número del agente: SIM física, conecta via Baileys al arrancar
- **Acceso SSH:** `root@157.230.152.202`, auth por password. La contraseña es `VPS_KEY` del `.env`
  local. No hay clave pública cargada → en Windows usar **`plink`** (PuTTY en
  `C:\Program Files\PuTTY\`): `plink -ssh -batch -pw "<VPS_KEY>" root@157.230.152.202 "<cmd>"`;
  en Mac/Linux, **`sshpass -e ssh`** con `SSHPASS` exportado.
- **Deploy:** workflow `.github/workflows/deploy.yml` (`workflow_dispatch`, con `alcance: dash|todo`).
  Hace **rsync de una allowlist** — el VPS no tiene credenciales de GitHub porque el repo es privado,
  así que `git pull` allá no funciona y `/root/juanito` **no es un repo git**. `alcance: dash` no
  toca el bot; `alcance: todo` reconstruye la imagen y **reconecta Baileys** (ojo con el softban).
- **Dashboard:** `https://juanito.tail2df10b.ts.net` (solo desde el tailnet de Tailscale).
- `/root/juanito` es un directorio de trabajo con años de respaldos a mano (`.env.bak-*`,
  `src.bak-*`, `brain.sqlite.bak-*`). El rsync del deploy **no** usa `--delete` fuera de
  `dashboard/`, justamente para no barrerlos.

## Historia técnica importante

**Softban anterior:** el proceso crasheaba y el supervisor lo reiniciaba cada ~15s sin backoff →
loop rápido de reconexiones desde datacenter → WhatsApp lo detectó.
**Solución:** `entrypoint.sh` con backoff 30→60→120→240→300s. No tocar sin entender el contexto.

## Reglas de trabajo en este repo

- No tocar `entrypoint.sh` sin entender el contexto del softban
- **Vincular WhatsApp solo desde IP residencial y copiar la sesión al VPS** — nunca escanear el QR
  desde el VPS. Ver `docs/WHATSAPP-PAIRING.md`
- Todo envío de WhatsApp pasa por `send-queue.js` y sale del proceso principal (tiene el socket)
- No exponer puertos en docker-compose (Baileys es conexión saliente)
- No agregar dependencias sin justificación clara
- `src/db/migrate.js` es idempotente — seguro de correr múltiples veces
- Los tests usan `__setDeps()` en `src/claude/index.js` para inyectar mocks

## Cómo retomar una sesión

1. Leer este archivo + el TL;DR de [docs/JUANITO-HANDOFF.md](docs/JUANITO-HANDOFF.md)
2. `git log --oneline -10` para ver el estado del repo
3. Pendientes reales → §18 del handoff
