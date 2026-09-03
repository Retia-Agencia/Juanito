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
| `dashboard/` | Consola de operación (contenedor `dash`). `server/` = API `node:http` (GET de lectura + POST de escritura en `actions.js`, apagados salvo los tabs de `DASH_WRITES`) + watchdog + botón Deploy; `src/` = SPA Vite/React; los dos `server/selftest*.js` ejercitan lectura y escritura contra una copia de la DB. Guía: [docs/DASHBOARD-ROADMAP.md](docs/DASHBOARD-ROADMAP.md) |
| `src/bot/` | Router (`index.js`), comandos (`commands.js`), guard anti-secuestro de grupos (`group-guard.js`) |
| `src/claude/index.js` | Claude: prompts, tool-use loop, memoria, reintentos. `untrusted.js` = encapsula el texto de terceros que cruza al system prompt del jefe (§18.BQ) |
| `src/whatsapp/` | Baileys (`index.js`), cola anti-ban (`send-queue.js`), cache de subjects |
| `src/common/http.js` | `fetchConDeadline`: TODA llamada saliente lleva deadline. El `fetch` de Node no trae timeout y un cuelgue ahí cuelga el job entero sin crashear el proceso (§18.BQ) |
| `src/common/roles.js` | Resolución de rol por LID (jefe / admin / **closer** / desconocido). `closerOf()` = identidad del closer desde su JID: fuente ÚNICA para todo lo de setteo |
| `src/setteo/` | Setteo reportado por el closer (§18.AZ). `parse.js`/`cuota.js`/`format.js` son PUROS (testeables en Windows); `capture.js`/`metricas.js` tocan DB + HubSpot. Captura determinista con fallback de IA (`setteo-ai.js`), calcado de `calendly/reschedule-ai.js` |
| `src/scheduler/` | Cron jobs — `index.js` los arranca y lista todos |
| `src/calendly/` | Recordatorios precall a closers. **`programs.js`** = registro `PROGRAMS` de primera clase (label, company, connection, eventType, pitch, materiales) — fuente única de la que se derivan los mapas de copy/ET. **`accounts.js`** = registro de **conexiones de Calendly** (token, org, dry-run; los eventTypes se derivan de `programs.js`). **`closers.js`** = roster keyeado por **persona con identidades** (una por conexión); deriva `CLOSERS`/`CLOSER_LIDS`. `workLid` PINNEA el destino de los pushes; `extraJids` agrega una COPIA a un segundo aparato (§18.BA) y **saltea el gate anti-ban** → solo con tráfico entrante probado. Modelo empresa/programa/closer: [ADR 0001](docs/adr/0001-modelo-empresa-programa-closer.md) + glosario [docs/agents/context.md](docs/agents/context.md). |
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

⚠️ **El ORDEN de las ramas en `roleOf()` es una decisión de seguridad, no de estilo.** El fallback
retrocompat *"cualquier `@lid` es el jefe si `BOSS_LID` no está configurado"* corre al final; la
rama de **closer** va antes que él y después del jefe/admin explícito. Si se mueve, en un
despliegue sin `BOSS_LID` todos los closers pasarían a ser `boss` y verían las tools del jefe.
Hay tests que lo fijan en `test/roles.test.js`.

## Comandos (DM admin)

`/confirmaciones [dm|grupo …] on|off` · `/calendly on|off [closer] [cuenta|todo]` · `/grupos` ·
`/reporte(s)` · `/persona <grupo> | <texto>` · `/programados [auto <id> on|off]` · `/aprobaciones` · `/respuestas` ·
`/status` · `/whoami` · `/id` — manual completo en [docs/MANUAL-DE-USO.md](docs/MANUAL-DE-USO.md).

**Del closer** (§18.AZ): `/missetteos [días]` · `/nuevosetteo <texto>`. Ojo: `/setteo` ya era
alias de `/setteos`, que es del JEFE (consolidado de todos) — por eso el del closer es
`/nuevosetteo`. La identidad sale del JID, así que ningún comando de closer acepta un nombre.

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

- No tocar `entrypoint.sh` sin entender el contexto del softban. Si igual hay que tocarlo,
  `scripts/test-entrypoint.sh` lo ejercita en segundos sin arrancar el bot (stubea `node` y
  `sleep`) y fija las dos propiedades: un crash loop real escala y se rinde a los 8 intentos; una
  caída aislada reinicia el contador **pero igual espera**. Correrlo bajo **busybox**, que es el
  shell de producción: `docker run --rm -v "$PWD:/ep" -w /ep --entrypoint sh juanito-agent
  /ep/scripts/test-entrypoint.sh /ep`
- **Vincular WhatsApp solo desde IP residencial y copiar la sesión al VPS** — nunca escanear el QR
  desde el VPS. Ver `docs/WHATSAPP-PAIRING.md`
- Todo envío de WhatsApp pasa por `send-queue.js` y sale del proceso principal (tiene el socket)
- No exponer puertos en docker-compose (Baileys es conexión saliente)
- No agregar dependencias sin justificación clara
- `src/db/migrate.js` es idempotente — seguro de correr múltiples veces
- Los tests usan `__setDeps()` en `src/claude/index.js` para inyectar mocks
- **En Windows `npm test` da ~64 fallos que NO son reales:** `better-sqlite3` no tiene binario
  para Node 24 y no compila sin VS Build Tools. Todo test que toque la DB revienta con
  *"Could not locate the bindings file"*. El baseline REAL se saca en Linux:
  ```
  docker build -f Dockerfile.test -t juanito-test .    # node:22-alpine + python3/make/g++ + npm ci
  docker run --rm -v "<repo>/src:/app/src:ro" -v "<repo>/test:/app/test:ro" -v "<repo>/dashboard/server:/app/dashboard/server:ro" juanito-test npm test
  ```
  (El volumen de `dashboard/server` NO es opcional: `test/dashboard.csrf.test.js` importa
  `dashboard/server/csrf.js`. Sin él, ese archivo da ERR_MODULE_NOT_FOUND y parece una regresión.)
  (En Git Bash, prefijar con `MSYS_NO_PATHCONV=1` y usar rutas `C:/…` o el volumen no monta y
  la suite reporta **0 tests** en verde, que es peor que fallar.)
  Baseline al **2026-09-02: 1142 tests, 1140 verdes, 2 rojos conocidos** (`call con TODOS sus
  pushes skipped…` y `reagenda manual superseded…`; los números de test se corren al agregar
  archivos, así que se buscan por nombre, no por índice). El tercer rojo histórico —links de
  Retia— murió solo al mudarse el sheet de Comunicarte (§18.BN). En Windows ese mismo commit da
  ~98 rojos — medir SIEMPRE la línea base con `git stash` antes de tocar nada y comparar contra
  ella, no contra cero.
  **Sin daemon de Docker local** (pasa seguido en el Mac) la suite igual se puede correr en Linux
  sin tocar el bot: `tar czf - src test package.json dashboard/server | ssh <vps> "tar xzf - -C /root/testrun"` y después `docker run --rm -v /root/testrun:/app/run -w /app/run --entrypoint node juanito-agent
  --test 'test/*.test.js'`. Node resuelve `node_modules` subiendo a `/app`, así que reusa el
  binario nativo de la imagen; `/app/src` no se toca.
  ⚠️ Dos formas de leer un verde que no existe: la suite sale en **TAP** (`# tests`, no `ℹ tests`),
  así que un grep por `ℹ` no encuentra nada y parece que no corrió; y `docker build … | tail` se
  queda con el **exit code de `tail`** → reporta 0 con el daemon caído. Verificar el `$?` del build
  y que el conteo sea ~1141, no 0. Por eso la lógica pura vive en módulos propios sin deps nativas: es la
  parte que sí se puede iterar en Windows.

## Cómo retomar una sesión

1. Leer este archivo + el TL;DR de [docs/JUANITO-HANDOFF.md](docs/JUANITO-HANDOFF.md)
2. `git log --oneline -10` para ver el estado del repo
3. Pendientes reales → §18 del handoff
