# 🧪 Smoke test Juanito — pre-entrega

**Qué validás:** lo desplegado LIVE pero aún no probado a fondo con mensajes reales
(§18.J + §18.K + §18.L + **§18.O** + **§18.Q** del [handoff](JUANITO-HANDOFF.md)). Todo lo demás ya
está verificado en vivo.

> **Estado al 2026-06-21:** el **núcleo de F (recordatorios a un grupo, §18.Q) ya se confirmó
> funcionando** en vivo — quedan sus variantes (F2–F4) y los bloques **G** (órdenes del jefe desde el
> grupo, §18.O) y **H** (aprobaciones en quiet hours + rescate al vencer, §18.O), que **nunca se
> probaron con mensajes reales**.

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

## ✅ Bloque F — Recordatorios ÚNICOS a un grupo (§18.Q)

Recordatorio de una sola vez que se **publica EN un grupo** (distinto de los recurrentes y de los
personales del jefe). **F1 ya está confirmado funcionando**; F2–F4 quedan pendientes.

- [x] **F1.** Por **DM admin/jefe**: `en el grupo <X> recuérdales en 2 minutos que <algo>`
      → confirma *"Recordatorio creado para el grupo «X» …"*; a los ~2 min aparece **en el grupo**
      `⏰ Recordatorio: <algo>`. *(✅ confirmado 2026-06-21.)*
- [ ] **F2.** **Dentro del grupo**, mencionándolo como jefe/admin: `@Juanito en 2 minutos recuérdanos <algo>`
      → confirma en el grupo; a los ~2 min se publica `⏰ Recordatorio: <algo>` en **ese mismo** grupo.
- [ ] **F3.** Por DM: `¿qué recordatorios tengo?` → el de grupo aparece con **`(en grupo X)`**.
      Luego `cancela el #N` → `cancelado ✅` y **no** se envía al grupo.
- [ ] **F4.** (default-deny) Por DM: `en el grupo <uno NO autorizado o inexistente> recuérdales algo`
      → **NO** lo crea; responde que el grupo no está autorizado / no lo encontró.

---

## ✅ Bloque G — Órdenes del jefe DESDE el grupo (§18.O)

Mencionando a Juanito **dentro de un grupo autorizado, como jefe/admin** (requiere `BOSS_LID`/`ADMIN_LID`
reales — `isStrictPrivileged`). **Nunca probado en vivo.**

- [ ] **G1.** `@Juanito recuérdame mañana a las 9am llamar a Pedro`
      → crea un recordatorio **personal**: la confirmación sale en el grupo, pero el recordatorio te
      llega a **tu DM** (no al grupo) a su hora.
- [ ] **G2.** `@Juanito prográmanos aquí todos los lunes a las 8am: "Buenos días, equipo"`
      → programa un mensaje **recurrente** a **este** grupo (confirma con el id). Verifícalo con
      `/programados` por DM; cancélalo después.
- [ ] **G3.** `@Juanito de ahora en adelante en este grupo háblanos con tono formal y trátanos de usted`
      → fija la **personalidad** de ese grupo (confirma). Una mención normal posterior debe notarse
      en ese tono. Quítala con `@Juanito olvida las instrucciones de este grupo`.
- [ ] **G4.** (control negativo) Desde el **teléfono desconocido**, en el grupo: `@Juanito recuérdame algo`
      → **NO** ejecuta órdenes; responde como chatbot general aislado (sin tools).

> ⚠️ Si G1–G3 no hacen nada (Juanito responde como chatbot normal), es señal de que `BOSS_LID`/`ADMIN_LID`
> no están seteados con tu identidad real → la vía estricta queda apagada por diseño. Confírmalo con `/whoami`.

---

## ✅ Bloque H — Aprobaciones: quiet hours + rescate al vencer (§18.O)

Requiere una confirmación **ON** (`/confirmaciones grupo <X> on` o `dm on`). **Nunca probado en vivo.**
Son sensibles al tiempo; para no esperar, un admin puede acortar ventanas por env y recrear el contenedor
(`REPLY_APPROVAL_TTL_MIN`, `QUIET_HOURS_START`/`QUIET_HOURS_END`).

- [ ] **H1 (rescate al vencer).** Con confirmación ON, provoca una pendiente (mención en el grupo / DM del
      desconocido) y **NO la decidas**. Al cumplirse el TTL (default 30 min):
      → al **remitente** le llega un aviso amable *("lo estoy validando…")*; a **ti** te re-llega el
      borrador con cómo rescatarla. Luego `apruebo #N` la **revive** (se publica) **o** `no #N` la descarta.
- [ ] **H2 (quiet hours).** Dentro de `QUIET_HOURS_START`–`END` (default 21:00–07:00, TZ del bot), provoca
      una pendiente: → a ti **NO** te notifica al instante y el reloj de 30 min **no** corre; al remitente
      le llega un aviso amable **una sola vez al día**. Al volver al horario laboral, te llega **un solo
      digest** con todas las retenidas y recién ahí arranca su TTL.

---

## 🔄 Dejar todo en default seguro (antes de la reunión)

- [ ] `/confirmaciones dm off`
- [ ] `/confirmaciones grupo <tu-grupo-de-prueba> off`
- [ ] `/confirmaciones` → verifica que **todo quedó OFF** (estado limpio).
- [ ] `/programados` → cancela el mensaje recurrente de prueba de **G2** si quedó activo.
- [ ] Si fijaste personalidad de prueba en **G3**, quítala (`@Juanito olvida las instrucciones de este grupo`).
- [ ] Si acortaste `REPLY_APPROVAL_TTL_MIN`/`QUIET_HOURS_*` por env para **H**, **revierte** los valores
      y recrea el contenedor (`docker compose up -d`).
- [ ] `/calendly` → confirma que el piloto de Rodriguez sigue **ON** (no lo tocaste).

---

**Criterio de aprobación:** si A1–A3, B1–B2, C1–C3, D1–D3, E1–E4 y **F1–F3** pasan, entregás sin riesgo
de sorpresa en vivo. C4/C5/D4/D5/E5, F4, y los bloques **G** y **H** son refuerzo (G/H dependen de tener
`BOSS_LID`/`ADMIN_LID` reales y de probar a la hora correcta).

**Si algo falla:** anota el bloque exacto y el log del contenedor (`docker compose logs --tail=50`)
y revísalo con calma — no improvises fixes la noche antes.
