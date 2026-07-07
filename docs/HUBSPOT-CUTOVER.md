# HubSpot como fuente del motor precall — validación y cutover

El motor precall (recordatorios a closers antes de sus llamadas) puede leer las citas desde
**HubSpot** (deals con propiedades `calendly_*`) en vez de Calendly, reusando el mismo motor
(`src/scheduler/calendly.js`) vía un adaptador (`src/hubspot/`). Este doc es el runbook para
validarlo y hacer el corte. Requiere el VPS arriba y un `HUBSPOT_TOKEN` (Private App;
scopes `crm.objects.deals.read` + `crm.schemas.deals.read`).

## Arquitectura en una línea

`HubSpot deals → src/hubspot/ (adaptador → forma de "evento" estilo Calendly) → runDigest /
runCalendlyPoll / runCalendlyDelivery (motor compartido) → cola anti-ban → WhatsApp`.

El mapeo de closer (`calendly_host_email → WhatsApp`) es el mismo `src/calendly/closers.js`;
el opt-in/anti-ban, los links `wa.me` y la tabla `calendly_pushes` se heredan sin duplicar.

## Paso 0 — Confirmar los open items (con el token, antes de enviar nada)

Correr el script de fetch en crudo (no toca DB ni WhatsApp):

```
HUBSPOT_TOKEN=pat-xxx node scripts/hubspot-fetch-check.mjs         # hoy (Bogotá)
HUBSPOT_TOKEN=pat-xxx node scripts/hubspot-fetch-check.mjs 2026-07-10
```

Verificar en la salida:
1. **`dealname`** — ¿es el nombre del lead? Si viene como "Programa - Empresa" u otro formato,
   hay que leer el `firstname` del contacto asociado (ajustar `dealToEvent` en `src/hubspot/index.js`).
2. **`telefono_de_contcato`** — ¿trae código de país? El link `wa.me` necesita E.164 sin `+`. Si
   viene sin `57`, normalizar en `dealToEvent`.
3. **Join URL** — ¿existe una propiedad del deal con el link de la llamada? Si sí, setear
   `HUBSPOT_JOINURL_PROP=<nombre>`; si no, el Push 3 sale sin link.
4. **Semántica de "cancelado"** — `getEvent` (en `src/hubspot/index.js`) asume que una cita sigue
   viva mientras el deal esté en la etapa **Agendado**; si sale de esa etapa lo trata como
   cancelado. Confirmar que ese es el comportamiento real (que un cancel/no-show mueve el deal de
   etapa) y ajustar si hace falta.

## Paso 1 — Validación en paralelo (sin riesgo, Calendly sigue enviando)

En el `.env` del VPS:

```
HUBSPOT_TOKEN=pat-xxx
# HUBSPOT_DRY_RUN=true        (default) → HubSpot NO envía, solo loguea
# HUBSPOT_PUSH3_ENABLED=false (default) → solo corren los digests Push 1/2
```

Restart. A las 7pm/6:30am comparar en el log:

```
[Calendly] Digest Push 1: N closers, M citas
[HubSpot]  Digest Push 1: N closers, M citas
```

Deben coincidir (mismos closers, mismos leads, mismas horas). Los `[HubSpot]` van con
`[DRY-RUN]` → no se envía nada. Iterar hasta que calcen de forma estable.

## Paso 2 — Cutover (HubSpot pasa a ser la fuente única)

⚠️ **Orden importa.** La tabla `calendly_pushes` es COMPARTIDA. Si se prende el Push 3 de
HubSpot con Calendly todavía vivo, el cron de delivery de Calendly (que no está en dry-run)
entregaría las filas de HubSpot. Por eso:

1. **Apagar Calendly primero:** quitar/vaciar `CALENDLY_TOKEN` (sus jobs se autodesactivan).
2. **Prender HubSpot real** en el `.env`:
   ```
   HUBSPOT_DRY_RUN=false        # envía de verdad
   HUBSPOT_PUSH3_ENABLED=true   # activa poll + delivery del Push 3 (25 min) y Push 0
   ```
3. Restart. Verificar en el log: `[HubSpot] Jobs activos ✅ — ENVÍO REAL ⚠️, Push 3 ON (cutover)`
   y que los digests/pushes salgan a los closers correctos.

## Rollback

Volver a `HUBSPOT_DRY_RUN=true` + `HUBSPOT_PUSH3_ENABLED=false` y re-poner `CALENDLY_TOKEN`.
Restart. (El botón de pánico `/calendly off` corta TODOS los envíos del motor al instante,
sirva la fuente que sirva, porque el gate `isCalendlyPaused` es compartido.)

## Pendiente (fase posterior)

- **Push 4 (outcome post-call)** está desactivado para la fuente HubSpot (`push4Enabled: false`
  en `src/scheduler/hubspot.js`); el registro de resultados por HubSpot queda para después.
- Endurecer el aislamiento de la tabla `calendly_pushes` por fuente (hoy la seguridad depende
  del orden del cutover descrito arriba).
