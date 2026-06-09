# Handoff — Recordatorios precall a closers (Calendly)

> Documento de traspaso para continuar el trabajo desde otro computador.
> Rama: `feat/calendly-precall-pushes`. Última sesión: 2026-06-07.
>
> **🟢 ESTADO (2026-06-08): blocker de LID RESUELTO (ver `docs/LID-ADMIN-HANDOFF.md`).
> Esta sesión añadió fixes de robustez (3 bugs) + catch-up + alertas, TODO con tests y un
> harness de escenarios que corre en Windows. Ver la sección de abajo
> [🟢 SESIÓN 2026-06-08](#-sesi%C3%B3n-2026-06-08-mani--fixes-de-robustez--harness-de-escenarios).
> Pendiente: deploy de estos fixes + Fase 2 (envío real). El VPS sigue en `DRY_RUN=true`.**

## 🟢 SESIÓN 2026-06-08 (Mani) — fixes de robustez + harness de escenarios

> **Resumen para el que sigue (desde Windows):** se arreglaron 3 bugs de
> correctitud y se implementaron 2 decisiones de diseño (catch-up + alertas), TODO
> con tests. Se construyó un **harness de escenarios** que simula la lógica de
> pushes sin tocar Calendly/DB/WhatsApp reales → corre en Windows con `node --test`
> (no necesita `better-sqlite3` ni token). **Nada se desplegó todavía**: el VPS
> sigue en `DRY_RUN=true` con el código de la sesión anterior. Falta deploy + Fase 2.

### Qué se arregló (bugs) y se decidió (diseño)

| # | Tema | Antes | Ahora |
|---|---|---|---|
| Bug 1 | **Doble envío por concurrencia** | el cron de entrega corre cada minuto y `cron` no previene solapes; un lote >1 min podía enviar dos veces | guard de reentrada `_delivering` + **claim atómico** (`status 'scheduled'→'sending'`) por fila |
| Bug 2 | **Reagenda tras envío** | si el Push 3 ya estaba `sent` y reagendaban a más tarde, no se mandaba uno nuevo | `decidePushAction` re-arma el push (`resetFromSent` → vuelve a `scheduled`) si la nueva hora es futura |
| Bug 3 | **`getFirstInvitee` sin retry** | un fallo transitorio tiraba el push sin nombre/teléfono del prospecto | 1 reintento con backoff de 500ms |
| Dec 4b | **Catch-up de reservas tardías** | si los 3 triggers ya pasaron, el closer no recibía nada | `computePush3Schedule` agenda **inmediato** si la llamada sigue en el futuro (sin piso — decisión del owner). Si la llamada ya pasó, no agenda |
| Dec 5 | **Alertas de fallos silenciosos** | token muerto / closer sin mapear fallaban solo en logs | **DM inmediato a `ADMIN_LID`** (deduplicado 6h) + estado en `/status` |

### Arquitectura del fix (importante para extender)

La **lógica de decisión vive en un módulo PURO** `src/calendly/push-logic.js`
(sin DB, sin red), que comparten el acceso a DB (`src/db/index.js`) y el harness de
tests. Esto es lo que permite testear los bugs #1/#2 y la decisión 4b **en Windows**
sin compilar `better-sqlite3`. Misma filosofía que los helpers puros de
`src/calendly/index.js`.

- `src/calendly/push-logic.js` — `computePush3Schedule()` (decisión 4b) +
  `decidePushAction()` (bug #2) + `sqliteUtcToMs()`. **Puro, testeable en cualquier lado.**
- `src/calendly/health.js` — estado en memoria + dedup de alertas (decisión 5). Puro.
- `src/scheduler/calendly.js` — **refactorizado a un seam de deps** (`__setDeps`/`__resetDeps`,
  igual patrón que `src/claude/index.js`): la API de Calendly, la DB y `sendMessage`
  se inyectan en tests. Aquí viven el catch-up, el guard de concurrencia y las alertas.
- `src/db/index.js` — `scheduleCalendlyPush` ahora delega la decisión a `decidePushAction`;
  nuevas funciones `claimCalendlyPush(id)` (claim atómico) y `revertCalendlyPush(id)`.
- `src/bot/commands.js` + `src/index.js` — `/status` enriquecido con `getHealth()`
  (último poll, último error, closers sin mapear).
- `src/calendly/index.js` — retry en `getFirstInvitee`.

### El harness de escenarios (lo que pediste para "ver" los casos)

`test/helpers/calendly-harness.js` reemplaza las 3 fronteras externas por dobles:
mock de la API de Calendly (fixtures), store en memoria de `calendly_pushes` (que usa
la MISMA lógica pura que el SQL real), spy de WhatsApp, y reloj inyectable. Así se
reproducen escenarios deterministas que el dry-run en vivo NO puede forzar (reserva
en 20 min, reagenda tras envío, concurrencia, etc.).

**Dos formas de usarlo:**

```powershell
# 1) Aserciones formales (verde/rojo):
node --test test/calendly.scenarios.test.js     # 12 escenarios de integración
node --test test/calendly.push-logic.test.js    # 11 unit tests de la lógica pura

# 2) Reporte legible — IMPRIME qué haría el sistema en cada escenario:
node scripts/calendly-scenarios.js
```

`scripts/calendly-scenarios.js` es un **"dry-run determinista"**: a diferencia de
`scripts/calendly-dryrun.js` (pega al Calendly real y solo muestra lo que haya hoy),
este no toca red/DB/WhatsApp y siempre muestra los 7 escenarios clave. Corre en
Windows sin token ni `better-sqlite3`.

### Cómo correr los tests (desde Windows)

```powershell
# ── Corren NATIVO en Windows (puros, sin better-sqlite3) ──
node --test test/calendly.helpers.test.js       # 13
node --test test/calendly.push-logic.test.js    # 11
node --test test/calendly.scenarios.test.js     # 12
node --test test/commands.test.js               # 7
node --test test/roles.test.js                  # 13
node --test test/brain.tools.test.js            # 12

# ── NO corren en Windows (necesitan better-sqlite3 nativo) → correr en Docker o VPS ──
#   test/data.calendly-pushes.test.js   (4 — valida el SQL de claim/revert/reschedule, bugs #1 y #2)
#   test/data.db.test.js                (6 — regresión de la DB)
```

> ⚠️ **`node --test` SIN argumentos FALLA** en Windows/Mac-node26 porque intenta
> correr también los tests de DB nativos. Correr SIEMPRE por archivo, o filtrar.
> En esta sesión los 2 tests de DB se validaron en un contenedor `node:22-alpine`
> (4/4 y 6/6 verdes). Para repetirlo donde haya Docker:
> ```powershell
> docker run --rm -v "${PWD}:/app" -w /app node:22-alpine sh -c "apk add --no-cache python3 make g++ && npm rebuild better-sqlite3 && node --test test/data.calendly-pushes.test.js test/data.db.test.js"
> ```

### ⚠️ Una cosa que marqué (revisar): `/status` del jefe

El test `test/commands.test.js` esperaba que `/status` del **jefe** devolviera `null`
(silencio → sigue a Claude). El código actual (cambio concurrente, no de estos fixes)
ahora devuelve una **deflexión cálida** ("Ese comando es solo para el equipo técnico 🙂").
Eso calza con la filosofía de baby-proofing ("deflectar con calidez"), así que
**actualicé el test** para reflejarlo. Si la deflexión NO era intencional, revertir
`src/bot/commands.js:22` a `return null`.

### Próximos pasos (en orden, para Windows)

1. **Correr la suite local** (comandos de arriba) para confirmar verde antes de tocar nada.
2. **Deploy al VPS** (mismo flujo del handoff LID, ver `docs/LID-ADMIN-HANDOFF.md`):
   `pscp -r src scripts test root@157.230.152.202:/root/juanito/` + `docker compose up -d --build`.
   - **No olvidar correr los tests de DB en el contenedor tras el build** (validación final del SQL).
   - `ADMIN_LID` ya se pasa en `docker-compose.yml` → las alertas de la decisión 5 llegarán solas.
   - Sigue todo en `DRY_RUN=true` por default: el deploy NO envía nada.
3. **Fase 2 — envío real controlado** con Sebastian Rodriguez (única receta validada, ver más abajo
   "Receta de prueba real controlada"). Ahora con el catch-up, una cita de prueba a <25 min también
   dispara.
4. **Rotar `CALENDLY_TOKEN` + contraseña del VPS** (siguen pendientes de sesiones previas).

### Estado del repo al cerrar esta sesión

- **Rama:** `feat/calendly-precall-pushes`. **NO commiteado todavía** (lo dejo para que revises el diff).
- Archivos nuevos: `src/calendly/push-logic.js`, `src/calendly/health.js`,
  `test/helpers/calendly-harness.js`, `test/calendly.push-logic.test.js`,
  `test/calendly.scenarios.test.js`, `test/data.calendly-pushes.test.js`, `scripts/calendly-scenarios.js`.
- Archivos tocados: `src/scheduler/calendly.js`, `src/db/index.js`, `src/db/migrate.js`,
  `src/calendly/index.js`, `src/bot/commands.js`, `src/index.js`, `test/commands.test.js`.
- **Sin nuevas env vars** ni nuevas dependencias. El estado `sending` es nuevo en `calendly_pushes`
  pero no requiere migración (la columna `status` es TEXT).

---

## Qué es esta feature

Juanito le recuerda a cada **closer** que mande sus "pushes" precall a los prospectos,
leyendo las citas reales de **Calendly** (API v2):

- **Push 1** — cron 7:00pm → digest de las llamadas de **mañana**, agrupado por closer.
- **Push 2** — cron 6:30am → digest de las llamadas de **hoy**, agrupado por closer.
- **Push 3** — 25 min antes de cada llamada → un mensaje por cita.

El closer = host del evento (`event_memberships[0].user_email`), mapeado a su WhatsApp
en `src/calendly/closers.js`. "Equipo EstadoX" se enruta a Mateo.

Archivos núcleo:
- `src/calendly/index.js` — cliente API + helpers PUROS (sin DB, sin deps nativas) + plantillas de mensajes.
- `src/scheduler/calendly.js` — crons (poll, deliver, push1, push2) + lógica de envío con DRY-RUN y opt-in.
- `src/calendly/closers.js` — mapa email→WhatsApp (8 closers).
- `src/calendly/optin.js` — registro anti-baneo (el closer escribe primero).
- `scripts/calendly-day-check.js` — **diagnóstico**: lista las citas de UN día (y opcional UN closer) con verificación de scoping por día.
- `scripts/calendly-dryrun.js` — corre UNA pasada completa (poll+push1+push2+deliver) en dry-run.
- `scripts/calendly-optins.js` — quién ya hizo opt-in / quién falta.

## Qué se hizo en esta sesión

1. **Ajustes de formato de los mensajes** (commiteados en esta rama):
   - Nuevo helper `fullNameFrom()` en `src/calendly/index.js` → usa **nombre completo** del prospecto
     (antes solo primer nombre). Resuelve el caso de dos prospectos con el mismo nombre el mismo día.
     Respeta lo que escribió el prospecto; solo capitaliza si vino todo en minúsculas.
   - `buildDigestMessage()` ahora muestra **conteo** ("tienes N llamadas...") con singular/plural.
   - Descriptores en las etiquetas: Push 3 `(antes de la llamada)`, Push 1 `(la noche anterior)`, Push 2 `(en la mañana)`.
   - Firmas retrocompatibles (`buildPush3Message`/items aceptan `name` o `firstName`).
   - Tests nuevos en `test/calendly.helpers.test.js` (12 pasan).

2. **Validación contra Calendly REAL** (token vivo, corrido localmente, sin tocar el VPS):
   - **Scoping por día: correcto.** Probado el lun 8-jun-2026: 28 citas, todas en el día correcto,
     incluso las del borde (llamada 8:00pm Bogotá = 01:00Z del día siguiente en UTC, bien asignada al día 8).
   - **Filtro de "programa": correcto.** El dom 7-jun solo había citas tipo "Entrevista 30X"
     (no son llamadas de venta) → el sistema correctamente NO las incluiría en los pushes.
   - **Mapeo de closers: completo** — cero hosts "sin mapear" en la muestra real.
   - Se renderizaron los Push 1 reales de Salazar (7 llamadas) y Maca (8 llamadas): formato OK.

## Estado actual (2026-06-07, post-deploy)

- ✅ Código de la feature: completo, tests 12/12.
- ✅ Formato de mensajes: validado con datos reales (4 días, scoping/filtro/mapeo/teléfonos OK).
- ✅ **Rama reconciliada con `origin/main`.** La rama estaba desactualizada: `origin/main` ya corría en
  el VPS con commits del otro dev (`abccd71` "fix: mensajes/@mention/rate-limit/timezone" + manejo de
  LID en `whatsapp/index.js`). Se hizo `git merge origin/main` → 4 conflictos aditivos resueltos
  ("conservar ambos"): `src/index.js`, `src/db/index.js`, `src/db/migrate.js`, `cleanup()`. Merge commit
  `6827b52`, + `f1c7eb5` (docker-compose). **Sin esto, un deploy ciego habría regresado los fixes del
  otro dev y roto el bot.**
- ✅ **DESPLEGADO en el VPS en DRY-RUN.** `docker compose up -d --build` corrido. Contenedor sano (1er
  intento, WA reconectó con la sesión existente, sin re-vincular), `migrate` creó las tablas, jobs activos
  con `DRY-RUN=true`. El poll lee Calendly real y agenda los Push 3.
- ✅ **Envío real validado end-to-end** con Pablo Lozano (opt-in sembrado en DB): `[Calendly] enviado
  (push1) → +573046131437`, y los otros 7 closers `OMITIDO ... sin opt-in`. El seguro por-closer funciona.
- ❌ **Opt-in self-service ROTO por LID** (ver sección dedicada). Ningún closer puede registrarse
  escribiéndole "Hola" a Juanito todavía → **blocker para invitar a los closers reales.**
- ℹ️ El contenedor quedó en **DRY-RUN=true** (inerte). En la DB quedó sembrado el opt-in de **Pablo**
  (`573046131437`); si se apaga el dry-run, Pablo recibiría pushes reales. Quitar con
  `DELETE FROM calendly_optins WHERE phone='573046131437'` si se quiere DB limpia.

## ⚠️ BLOCKER para el rollout: opt-in de closers roto por LID

**Síntoma:** un closer le escribe "Hola" a Juanito y, en vez del "Quedaste registrado ✅", Juanito le
responde como **asistente del jefe** (ej. "Ey, que necesitas"). El closer NO queda registrado.

**Evidencia (logs, con Pablo):**
```
[Debug] text="Hola" rawJid=254051828641894@lid isGroup=false
[Main] DM de LID no resuelto: 254051828641894@lid — tratando como jefe
[Bot] Jefe: Hola
```

**Causa raíz:** los DMs de WA multi-device llegan con `remoteJid = <num>@lid` (LID del protocolo Signal,
NO el número). `whatsapp/index.js` intenta resolver LID→teléfono con `lidMap` (alimentado por
`contacts.upsert`), pero para los closers **no resuelve** (no están como contactos con mapeo conocido).
Entonces `sender` llega como `@lid` crudo, y en `src/index.js`:
```js
const isBoss = phonesMatch(sender, BOSS_PHONE()) || sender?.endsWith('@lid');
```
→ **cualquier `@lid` no resuelto se trata como jefe** → va a `handleBossMessage`, nunca a
`handleCloserOptin`. Además `resolveCloserByPhone` (en `optin.js`) busca por número, así que ni siquiera
podría mapear un `@lid` a su closer.

**Dos problemas, no uno:**
1. **Funcional:** el closer no se puede auto-registrar (no llega al opt-in).
2. **Seguridad:** *cualquier* DM cuyo LID no resuelva (no solo closers) obtiene la persona/acceso de JEFE.

**Direcciones de fix (toca tu capa de WA — coordinar):**
- **Identificar al jefe por su LID real, no por "es @lid".** Capturar/configurar el/los LID del jefe
  (en los logs el jefe llegó como `147313234280449@lid`) y que `isBoss` matchee SOLO ese LID. Así los
  demás `@lid` dejan de ser "jefe" y pueden enrutarse al opt-in.
- **Resolver LID→número de los closers** para que `handleCloserOptin` pueda identificarlos. Opciones:
  (a) guardar los 8 closers como contactos en el teléfono del bot → `contacts.upsert` poblaría `lidMap`;
  (b) lookup activo (`sock.onWhatsApp`/contactos) al recibir el DM; (c) registrar por `msg.pushName` o un
  código que el closer envíe.
- Archivos involucrados: `src/whatsapp/index.js` (resolución LID, tu capa), `src/index.js` (enrutamiento
  jefe vs opt-in), `src/calendly/optin.js` (`handleCloserOptin`/`resolveCloserByPhone`).

**Workaround para probar SIN el fix (lo que se usó):** sembrar el opt-in directo en la DB por número
(`registerOptin`), que la entrega no depende del LID.

## Hallazgos importantes (no obvios)

1. **El `CALENDLY_TOKEN` usado en la validación es el PAT personal de Sebastian _Rodriguez_**
   (`sebastian@30x.com`), no de una cuenta de servicio. Tiene visibilidad de toda la org (sirve),
   **pero hay que rotarlo**: quedó expuesto en un chat y depende de un usuario que podría salir del equipo.
   Para producción conviene un token de owner/cuenta de servicio.
2. **Hay dos "Sebastian":** Rodriguez (`sebastian@30x.com`) y Salazar (`sebastian.salazar@30x.com`).
   Son closers distintos con números distintos en `closers.js`. No confundirlos.
3. **`getFirstInvitee` puede fallar de forma transitoria** (red/rate-limit). El código lo tolera con
   fallback a "el prospecto", pero ocasionalmente una línea del digest podría salir sin nombre/teléfono
   aunque el dato exista. Ver "Mejoras opcionales".
4. **Anti-baneo ya implementado:** `deliver()` exige opt-in (`CALENDLY_REQUIRE_OPTIN=true` por default).
   Juanito NUNCA escribe en frío; el closer debe escribirle primero (`handleCloserOptin`). Además
   `CALENDLY_DRY_RUN` está en `true` por default (no envía nada, solo loguea).

## Cómo continuar desde tu computador

### 1. Setup local

```bash
git checkout feat/calendly-precall-pushes
git pull
npm install --ignore-scripts   # en Windows better-sqlite3 no compila; los scripts de Calendly son puros y no lo necesitan
```

### 2. Correr los tests puros (no requieren DB ni token)

```bash
node --test test/calendly.helpers.test.js
```

### 3. Validar contra Calendly real (necesitas un CALENDLY_TOKEN válido)

> El módulo Calendly es puro: estos scripts corren localmente sin Docker ni DB.

```bash
# PowerShell:
$env:CALENDLY_TOKEN='<token>'; node scripts/calendly-day-check.js 2026-06-08 "sebastian.salazar@30x.com"
# bash/zsh:
CALENDLY_TOKEN='<token>' node scripts/calendly-day-check.js 2026-06-08
```
`calendly-day-check.js [YYYY-MM-DD] [emailOrNombreParcialDelCloser]`. Si alguna línea sale con
`⚠️ OTRO DÍA`, el scoping por día tiene fuga (no debería).

## Próximos pasos (en orden)

1. ✅ ~~Deploy al VPS~~ — HECHO (en dry-run). `docker-compose.yml` ya pasa las vars `CALENDLY_*` y el
   `Dockerfile` ya copia `scripts/`. El `.env` del VPS ya tiene `CALENDLY_TOKEN` + flags.
2. **[BLOCKER] Arreglar el opt-in/LID** (ver sección dedicada arriba). Es lo que falta para que los
   closers puedan registrarse solos. Coordinar porque toca `whatsapp/index.js`.
3. **Rotar el `CALENDLY_TOKEN`** (es el PAT personal de Sebastian Rodriguez, pasó por chat) a una
   cuenta de servicio/owner. Cambiarlo en el `.env` del VPS y `docker compose up -d`.
4. **Opt-in de los closers**, una vez arreglado el LID: que guarden el número de Juanito y manden "Hola";
   verificar con `docker compose exec agent node scripts/calendly-optins.js`.
5. **Activar envío real**: `CALENDLY_DRY_RUN=false` en el `.env` del VPS + `docker compose up -d`.
   Empezar con un subconjunto de closers (el seguro de opt-in lo permite: solo reciben los registrados).

## Operación en el VPS (gotchas importantes)

- **Acceso:** DigitalOcean `157.230.152.202`, código en `/root/juanito` (NO es repo git → se sincroniza
  con `pscp`). SSH solo por contraseña como `root` (`plink -pw` / `pscp -pw`). **Rotar esa contraseña**
  (pasó por chat).
- **Aplicar cambios de código:** `pscp -r src scripts docker-compose.yml Dockerfile root@IP:/root/juanito/`
  y luego `docker compose up -d --build`. NO copiar `package*.json`/`entrypoint.sh` salvo que cambien
  (deps no cambiaron; `entrypoint.sh` es sensible por el softban).
- **Aplicar solo cambios de `.env`:** `docker compose up -d` (sin `--build`) recrea el contenedor con las
  nuevas vars. Cada recreación = 1 reconexión de WA (controlada, la maneja `entrypoint.sh`; el peligro es
  el loop rápido, no un restart puntual).
- **⚠️ `docker compose exec ... node -e` NO puede ENVIAR WhatsApp.** Arranca un proceso SEPARADO que
  comparte la DB pero NO el socket de WA (que vive solo en el proceso principal `node src/index.js`) →
  `sendMessage` lanza "WhatsApp no conectado aún". Por eso `calendly-dryrun.js` (solo loguea) sí corre por
  `exec`, pero un **envío real debe salir del proceso principal vía un cron**.
- **Receta de prueba real controlada (la que se usó con Pablo):** sembrar el opt-in del sujeto por número
  en la DB (`registerOptin`), poner `CALENDLY_DRY_RUN=false` + `CALENDLY_PUSH1_CRON=<minuto+5> <hora> * * *`
  en el `.env` (los crons usan TZ `America/Bogota` vía Intl, aunque `date` del contenedor diga UTC porque
  Alpine no trae tzdata), `docker compose up -d`, esperar el minuto del cron (runPush1 tarda ~40s por el
  throttle de invitees), verificar `[Calendly] enviado (push1) → <número>`, y **revertir** (`DRY_RUN=true`,
  quitar `CALENDLY_PUSH1_CRON`). Solo los opted-in reciben; el resto sale `OMITIDO ... sin opt-in`.
- **Rollback listo (de este deploy):** código `/root/juanito-backup-20260607-114841.tar.gz`; imagen
  `juanito-agent:pre-calendly-20260607-114841` (mismo id que la previa). Para volver: restaurar el tar y
  `docker compose up -d --build`, o `docker tag` la imagen de rollback a `:latest` y `up -d`.

## Mejoras opcionales (discutidas)

- ✅ ~~**Reintento en `getFirstInvitee`**~~ — HECHO en la sesión 2026-06-08 (bug #3).
- **Forzar Title Case** en nombres (hoy "Juan pineres" se respeta tal cual). Cambio de una línea en
  `fullNameFrom` si se prefiere homogeneizar.
- **Digests idempotentes / trazados**: hoy Push 1/2 no se registran por-closer, así que un reinicio a
  mitad del cron puede dejar a algún closer sin su digest (Push 3 sí es resiliente). No crítico; anotado
  para una futura iteración.
- **Caps anti-ban** (tope de mensajes salientes/min y por closer/día) — del roadmap de baby-proofing.

## Variables de entorno de Calendly

| Var | Default | Rol |
|---|---|---|
| `CALENDLY_TOKEN` | — (requerido) | PAT de la API v2. Sin él, los jobs se desactivan. |
| `CALENDLY_DRY_RUN` | `true` | Si != `false`, no envía WhatsApp (solo loguea). |
| `CALENDLY_REQUIRE_OPTIN` | `true` | Si != `false`, no envía a closers sin opt-in. |
| `CALENDLY_EVENT_TYPES` | 2 event_types hardcoded | CSV de event_types de programa a vigilar. |
| `CALENDLY_GROUP_URI` | grupo hardcoded | Grupo de Calendly a consultar. |
| `CALENDLY_PUSH3_LEAD_MIN` | `25` | Minutos antes de la llamada para Push 3. |
| `CALENDLY_PUSH1_CRON` | `0 19 * * *` | Cron Push 1 (7:00pm). |
| `CALENDLY_PUSH2_CRON` | `30 6 * * *` | Cron Push 2 (6:30am). |
| `CALENDLY_POLL_CRON` | `*/5 * * * *` | Cron del poll que agenda Push 3. |
