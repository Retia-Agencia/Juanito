# Setteo a leads que no agendaron — Puesta en producción (§18.AD)

> Motor de setteo dentro de Juanito: detecta leads que NO reservaron llamada y les envía una
> cadencia corta (máx 2 toques) de **plantillas aprobadas** por la **WhatsApp Business Cloud API
> oficial (Twilio)** desde un número **dedicado** — nunca por Baileys → **cero riesgo de ban** al
> número de Juanito. Detalle técnico en `docs/JUANITO-HANDOFF.md` §18.AD.

El código ya está mergeado y arranca **inerte**: en `SETTING_DRY_RUN=true` (default) y con los jobs
autodesactivados si faltan credenciales. Lo único pendiente es **configuración externa** (Twilio/Meta)
+ el `.env`. Esta guía es el checklist completo.

---

## 0. Regla de oro (no romper)

- El número del setteo debe ser **DEDICADO**: **no** el de Juanito y **no** uno ya activo en la app
  de WhatsApp. Un número en Cloud API **no puede** correr en Baileys/app a la vez.
- Fase 1 es **solo saliente**: Juanito dispara plantillas; las **respuestas del lead caen en el inbox
  de Twilio** y las atiende el setter (el repo no expone puertos → sin webhook por ahora).

---

## 1. Cuenta y número (Twilio + Meta) — bloquea el arranque

- [ ] **Cuenta Twilio** paga con WhatsApp habilitado (la trial no envía fuera del sandbox).
- [ ] **Meta Business verificado** (Business Manager). Sin verificación de negocio los límites de
      envío son muy bajos. Twilio lo conecta al registrar el sender.
- [ ] **Comprar un número en Twilio** (no necesitas SIM física).
- [ ] **Registrar el número como WhatsApp sender** en Twilio (display name + categoría del negocio).
      Aquí Meta hace su revisión.

## 2. Plantillas aprobadas — bloquea el arranque

Categoría **marketing** (es re-enganche a agendar, no transaccional). Variable `{{1}}` = nombre.
Incluir una línea de baja ("Responde BAJA para no recibir más"). Aprobación de Meta: **24–48h**.

- [ ] **Toque 1** — recordatorio para agendar la llamada. → anota su **Content SID** (`HX…`).
- [ ] **Toque 2** — seguimiento final (~48h después). → anota su **Content SID** (`HX…`).

> Si falta el SID de un toque, ese toque se **salta** (no se inventa texto libre: fuera de la ventana
> de 24h solo valen plantillas aprobadas).

## 3. Variables de entorno (`.env` del VPS)

```bash
TWILIO_ACCOUNT_SID=AC...              # SID de la cuenta
TWILIO_AUTH_TOKEN=...                 # Auth token — NO commitear
TWILIO_WA_FROM=573001112233           # número dedicado, solo dígitos con código país
SETTING_TEMPLATE_ABOGADOS_TOUCH1=HX...
SETTING_TEMPLATE_ABOGADOS_TOUCH2=HX...
SETTING_DRY_RUN=true                  # dejar true hasta validar; luego false para enviar de verdad
```

Opcionales (tienen default seguro, solo si quieres ajustar):

```bash
SETTING_CRON=*/10 * * * *             # cada cuánto enrola + entrega
SETTING_ENROLL_MAX_AGE_H=48           # solo enrola leads postulados en las últimas N horas
SETTING_TOUCH1_DELAY_MIN=120          # toque 1 a las ~2h de detectar al lead sin agendar
SETTING_TOUCH2_DELAY_MIN=2880         # toque 2 a las ~48h del toque 1
SETTING_DEFAULT_CC=57                 # código país si el teléfono del Form viene sin él (Colombia)
```

`GOOGLE_SA_KEY` ya está configurado (lo usa el reporte de Sheets) → la fuente de leads de EstadoX no
necesita nada más.

## 4. ⚠️ Pasar las vars al contenedor (`docker-compose.yml`)

`docker-compose.yml` es una **allowlist**: una var que no esté en el bloque `environment:` **no llega
al contenedor** aunque esté en el `.env`. Agrega este bloque (junto al de Calendly/Sheets):

```yaml
      # Setteo a leads que no agendaron (§18.AD) — Cloud API oficial (Twilio). Sin credenciales
      # Twilio o sin GOOGLE_SA_KEY el job se autodesactiva. Arranca en DRY_RUN por default.
      - SETTING_DRY_RUN=${SETTING_DRY_RUN:-true}
      - TWILIO_ACCOUNT_SID=${TWILIO_ACCOUNT_SID:-}
      - TWILIO_AUTH_TOKEN=${TWILIO_AUTH_TOKEN:-}
      - TWILIO_WA_FROM=${TWILIO_WA_FROM:-}
      - SETTING_TEMPLATE_ABOGADOS_TOUCH1=${SETTING_TEMPLATE_ABOGADOS_TOUCH1:-}
      - SETTING_TEMPLATE_ABOGADOS_TOUCH2=${SETTING_TEMPLATE_ABOGADOS_TOUCH2:-}
      - SETTING_CRON=${SETTING_CRON:-*/10 * * * *}
      - SETTING_ENROLL_MAX_AGE_H=${SETTING_ENROLL_MAX_AGE_H:-48}
      - SETTING_TOUCH1_DELAY_MIN=${SETTING_TOUCH1_DELAY_MIN:-120}
      - SETTING_TOUCH2_DELAY_MIN=${SETTING_TOUCH2_DELAY_MIN:-2880}
      - SETTING_DEFAULT_CC=${SETTING_DEFAULT_CC:-57}
```

## 5. Validación antes de abrir la llave

- [ ] Deploy con `SETTING_DRY_RUN=true`. En logs debe aparecer:
      `[Setteo] Job de setteo activo ✅ — DRY-RUN (no envía)`.
- [ ] `/setteo` (por DM admin) → "Cloud API (Twilio): configurada ✅", "DRY_RUN: ON".
- [ ] Revisar la tabla `setting_schedules` en la DB del volumen: se agendan toque 1 y 2; un lead con
      col I ya llena queda `cancelled`; correr dos ciclos solapados no debe doble-enviar (claim atómico).
- [ ] **Prueba real acotada:** `SETTING_DRY_RUN=false` y envía a **tu propio número** (mételo como
      lead de prueba o usa el sandbox de Twilio). Confirma que llega la plantilla con tu nombre en `{{1}}`.
- [ ] **Abrir a producción:** `SETTING_DRY_RUN=false` + redeploy.

## 6. Operación diaria

- `/setteo` — estado (pausa, credenciales, DRY_RUN, conteo de toques por estado).
- `/setteo off` — **botón de pánico global** (corta enrolamiento y envío sin redeploy). `/setteo on`
  para reactivar.
- `/setteo baja <número>` — da de **baja** a un número (no recibe más setteo y se cancelan sus toques
  vivos). En Fase 1, el equipo lo marca a mano al ver una baja en el **inbox de Twilio**.
  `/setteo alta <número>` revierte.
- **Vigilar el quality rating** del número en Twilio/Meta las primeras semanas. Si baja, `/setteo off`,
  revisar copy/segmentación, y no pasar de 2 toques.

## 7. Comandos de deploy (referencia)

Mismo procedimiento que el resto del repo (ver §18.AC del handoff y la memoria de deploy):

```bash
# En local: subir código
pscp -r src test docker-compose.yml <user>@<vps>:/root/juanito/
# En el VPS:
docker compose up -d --build     # aplica migración (setting_schedules/optouts) al arrancar
docker compose logs -f juanito   # confirmar "[Setteo] Job de setteo activo ✅"
```

La migración (`src/db/migrate.js`) es idempotente y corre al arrancar: crea `setting_schedules` +
`setting_optouts` sin tocar lo existente.

---

## Fase 2 (pendiente) — 30X vía HubSpot

Mismo motor, nueva fuente `src/setting/lead-source-30x.js` que lee el tag `DESATENDIDO`
(`hs_tag_ids` = `25397556`) + teléfono vía la **HubSpot API con un private-app token del runtime**
(`HUBSPOT_TOKEN`) — el MCP de HubSpot es del lado de Claude, no del bot. No requiere workflows de
HubSpot.
