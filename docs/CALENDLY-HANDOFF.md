# Handoff — Recordatorios precall a closers (Calendly)

> Documento de traspaso para continuar el trabajo desde otro computador.
> Rama: `feat/calendly-precall-pushes`. Última sesión: 2026-06-07.
>
> **🟡 ESTADO (2026-06-07): DESPLEGADO en el VPS en DRY-RUN (inerte). Envío real validado
> end-to-end con un closer (Pablo). Hay UN blocker para el rollout real: el opt-in self-service
> está roto por el manejo de LID. Ver sección [⚠️ BLOCKER: opt-in roto por LID](#-blocker-para-el-rollout-opt-in-de-closers-roto-por-lid).**

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

## Mejoras opcionales (discutidas, no implementadas)

- **Reintento en `getFirstInvitee`** (1 retry con backoff corto) para reducir las líneas que caen a
  "el prospecto" por fallos transitorios de la API.
- **Forzar Title Case** en nombres (hoy "Juan pineres" se respeta tal cual). Cambio de una línea en
  `fullNameFrom` si se prefiere homogeneizar.

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
