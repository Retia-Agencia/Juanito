# Handoff — Recordatorios precall a closers (Calendly)

> Documento de traspaso para continuar el trabajo desde otro computador.
> Rama: `feat/calendly-precall-pushes`. Última sesión: 2026-06-07.

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

## Estado actual

- ✅ Código de la feature: completo y con tests pasando.
- ✅ Formato de mensajes: validado con datos reales.
- ❌ **NO desplegado en el VPS.** El contenedor `juanito-agent` corre una imagen vieja (build 2026-06-05),
  anterior a Calendly. El host `/root/juanito` tampoco tiene el módulo Calendly ni `CALENDLY_TOKEN`.
- ❌ Opt-ins de closers: pendientes (ninguno ha escrito a Juanito todavía).

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

1. **Rotar el `CALENDLY_TOKEN`** (idealmente a una cuenta de servicio/owner) y nunca pegarlo en chats.
2. **Opt-in de los closers (anti-baneo), ANTES de enviar nada real:**
   - Pedirles que **guarden el número de Juanito** y le manden un "Hola".
   - Verificar con `docker compose exec agent node scripts/calendly-optins.js` (en el VPS).
   - No pasar a envío real hasta que todos aparezcan registrados.
3. **Deploy al VPS** (DigitalOcean `157.230.152.202`, código en `/root/juanito`, NO es repo git → se copia con `pscp`; SSH solo por contraseña como `root` con `plink -pw`):
   - Subir `src/` actualizado.
   - Agregar `CALENDLY_TOKEN` (y opcional `CALENDLY_EVENT_TYPES`, `CALENDLY_GROUP_URI`) al `.env`.
   - **Nota:** `docker-compose.yml` actual NO pasa las vars `CALENDLY_*` al contenedor → hay que
     agregarlas al bloque `environment:` además del `.env`.
   - `docker compose up -d --build` (esto reinicia el contenedor y reconecta WhatsApp; ojo con la
     historia del softban y `entrypoint.sh` — ver `CLAUDE.md`).
4. **Prueba en DRY-RUN en el VPS** antes de activar envíos:
   - `docker compose exec agent node scripts/calendly-dryrun.js` (revisa los logs, no envía WhatsApp).
5. **Activar envío real** solo cuando opt-ins estén completos: poner `CALENDLY_DRY_RUN=false` en `.env`
   y reiniciar. Empezar con un subconjunto de closers si se quiere ser conservador.

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
