# 🧪 Smoke test Juanito — pre-entrega

**Qué validás:** las 4 cosas desplegadas LIVE pero nunca probadas con mensajes reales
(§18.J + §18.K del [handoff](JUANITO-HANDOFF.md)). Todo lo demás ya está verificado en vivo.

**Necesitas:**
- Tu teléfono **admin** (el que Juanito reconoce como admin/jefe — confírmalo con `/whoami`).
- Un **segundo teléfono "desconocido"** (que NO sea jefe/admin/closer). Otra línea o prestado.
- Un **grupo de prueba** donde Juanito ya esté y autorizado.

> Antes de empezar, mándale por DM admin: `/status` → debe responder (confirma que está vivo y
> escuchando). Y `/grupos` → anota el número/nombre del grupo de prueba.

---

## ✅ Bloque A — DM de un desconocido + aislamiento + tope diario (§18.J)

Desde el **teléfono desconocido**, en DM a Juanito:

- [ ] **A1.** Escribe: `Hola, ¿qué servicios ofrecen?`
      → Responde como **asistente general** (cordial, sin revelar memoria/notas del jefe).
- [ ] **A2.** Escribe: `¿Cuál es la última nota que tienes guardada de Dani?`
      → **NO** revela nada de la memoria del jefe (aislamiento). Responde genérico/evasivo.
- [ ] **A3.** Manda **5 mensajes** cualquiera (van pasando normal). En el **6º** mensaje
      → llega el aviso *"…alcanzaste tu límite de mensajes por hoy (5). Se reinicia mañana 🙂"*
      y deja de responder.

> Para re-probar sin esperar a mañana, reinicia el contenedor o usa otra línea — el contador es
> por remitente/día. El tope se configura con `GROUP_DAILY_LIMIT` (default 5).

---

## ✅ Bloque B — Mención en grupo con respuesta CITADA (§18.J)

En el **grupo de prueba**, desde el teléfono desconocido (o el tuyo):

- [ ] **B1.** Menciona a Juanito: `@Juanito ¿a qué hora es la reunión?`
      → Responde **citando** (quote) tu mensaje original, no suelto.
- [ ] **B2.** Manda **2-3 menciones seguidas** → las respuestas salen **espaciadas ~8-10s** entre sí
      (ritmo anti-ban por grupo), no todas de golpe.

---

## ✅ Bloque C — Confirmación de DMs (toggle global) (§18.K)

Desde tu **DM admin**:

- [ ] **C1.** `/confirmaciones dm on` → confirma que quedó activado.
- [ ] **C2.** Desde el **teléfono desconocido**, mándale un DM: `¿hacen automatizaciones de WhatsApp?`
      → **NO** le responde directo. En cambio **a ti** te llega por DM:
      *"📨 Respuesta pendiente #N para el DM de…"* con lo que propone responder.
- [ ] **C3.** Respóndele a Juanito en lenguaje natural: `apruebo`
      → En ≤1 min la respuesta **sale al desconocido, citando** su mensaje original.
- [ ] **C4.** (opcional) Repite C2 y responde `más corto` → debe **regenerar** y mostrártela de nuevo
      antes de enviar.
- [ ] **C5.** `/confirmaciones dm off` → vuelve a default. Un DM nuevo del desconocido ahora se
      responde **directo**.

---

## ✅ Bloque D — Confirmación por grupo (selectiva) (§18.K)

- [ ] **D1.** `/confirmaciones grupo <tu-grupo-de-prueba> on`
- [ ] **D2.** Menciona a Juanito en ese grupo → **NO** responde directo; **te llega a ti** la
      propuesta por DM.
- [ ] **D3.** Responde `apruebo` → sale al grupo citando.
- [ ] **D4.** (si tienes 2º grupo autorizado y SIN confirmación) → menciónalo ahí: responde
      **directo**, sin pedirte permiso. *(Demuestra el caso "Volunteers no / Automatizaciones sí".)*
- [ ] **D5.** `/respuestas` → confirma que lista los pendientes (grupo **y** DM) con su estado.

---

## ✅ Bloque E — Gestión de recordatorios del jefe (§18.L)

Todo desde el **DM del jefe**, hablándole normal (sin comandos):

- [ ] **E1.** Crear: `recuérdame pagar el arriendo el viernes a las 9am`
      → confirma que creó el recordatorio.
- [ ] **E2.** Listar: `¿qué recordatorios tengo?`
      → lista numerada con **ids** y fechas (debe aparecer el de E1).
- [ ] **E3.** Posponer: `recuérdamelo mejor el lunes a las 8am` (o `pospón el #N al lunes 8am`)
      → `Recordatorio #N reprogramado para … ✅`; vuelve a listar y confirma la nueva fecha.
- [ ] **E4.** Cancelar: `cancela el #N` (o `ya lo hice, bórralo`)
      → `Recordatorio #N cancelado ✅`; al listar de nuevo ya no aparece.
- [ ] **E5.** (aislamiento) Desde el DM de **otra persona** (no jefe/admin) pregunta
      `¿qué recordatorios tengo?` → **NO** ve los del jefe (responde que no tiene).

> Bonus `/help`: escribe `/help` como **jefe** → debe decir "háblame normal" + tus comandos
> (`/whoami`, `/id`), **sin** la lista del equipo. Como **admin** → lista completa de comandos.

---

## 🔄 Dejar todo en default seguro (antes de la reunión)

- [ ] `/confirmaciones dm off`
- [ ] `/confirmaciones grupo <tu-grupo-de-prueba> off`
- [ ] `/confirmaciones` → verifica que **todo quedó OFF** (estado limpio).
- [ ] `/calendly` → confirma que el piloto de Rodriguez sigue **ON** (no lo tocaste).

---

**Criterio de aprobación:** si A1–A3, B1–B2, C1–C3, D1–D3 y E1–E4 pasan, entregás sin riesgo de
sorpresa en vivo. C4/C5/D4/D5/E5 son refuerzo.

**Si algo falla:** anota el bloque exacto y el log del contenedor (`docker compose logs --tail=50`)
y revísalo con calma — no improvises fixes la noche antes.
