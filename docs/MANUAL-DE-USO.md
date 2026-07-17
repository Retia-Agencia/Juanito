# Manual de uso — Comandos de Juanito

Guía práctica de los comandos que el **equipo (admin)** y el **jefe** usan por WhatsApp para
controlar a Juanito. Todos los comandos se escriben **por DM** (mensaje privado a Juanito), salvo
`/grupo` que se usa **dentro del grupo**.

> Para el detalle técnico y el estado vivo del proyecto, ver [JUANITO-HANDOFF.md](JUANITO-HANDOFF.md).
> Esta guía es de **operación**: qué escribir y qué hace.

---

## Quién puede usar cada comando

Juanito reconoce a cada quien por su rol (resuelto en `src/common/roles.js`):

- **admin** (equipo técnico): puede usar **todos** los comandos.
- **jefe** (Dani): usa los comandos de aprobación por lenguaje natural (ver más abajo). Los comandos
  marcados *(admin)* le devuelven una deflexión cálida ("eso es del equipo técnico 🙂").
- **closer / desconocido**: no tienen acceso a comandos.

`/whoami`, `/id` y `/help` son la excepción: **cualquiera** puede usarlos. `/help` es **role-aware**:
el equipo ve la lista de comandos, el jefe ve "háblame normal" + sus dos comandos, un desconocido ve
un saludo mínimo.

---

## 👔 Qué hace el jefe (sin comandos)

El jefe **no necesita aprender comandos**. Su control de Juanito es **conversacional**: le habla
normal por DM y Juanito entiende. Los comandos `/` marcados *(admin)* son del equipo técnico; al
jefe le devuelven una deflexión cálida.

**Comandos `/` que el jefe sí puede usar:** solo `/whoami` y `/id` (ver su ID y rol). Nada más.

**Lo que el jefe controla hablándole normal (lenguaje natural, sin sintaxis):**

| Qué quiere hacer | Cómo lo dice (ejemplos) |
|---|---|
| **Aprobar** una respuesta pendiente (grupo o DM) | "apruebo", "envíala", "dale", "está bien" |
| **Corregir** antes de enviar | "más corto", "dile que el martes", "cámbiala" |
| **Rechazar** | "no", "no respondas", "descártala" |
| **Aprobar/rechazar** un mensaje generado del día | igual: "apruebo" / "no, hoy no" |
| **Programar** un mensaje recurrente a un grupo | "en el grupo Patah todos los jueves a las 8pm manda…" |
| **Crear** un recordatorio (para él o para otro) | "recuérdame pagar el arriendo el viernes a las 9am" |
| **Crear** un recordatorio único que se publique **en un grupo** | por DM: "en el grupo Patah recuérdales el domingo a las 8am la reunión"; o dentro del grupo (mencionándolo): "@Juanito a las 5 recuérdanos que tenemos misa" |
| **Ver/cancelar/posponer** sus recordatorios | "¿qué tengo pendiente?", "cancela el de las 3", "recuérdamelo mañana mejor" |
| **Pedir/recordar/consultar** cosas | le habla normal: tiene memoria, notas y recordatorios |

Cuando una confirmación está activa, Juanito le escribe primero por DM (*"📨 Respuesta pendiente
#N para…"*) y el jefe decide ahí mismo en una frase. **El DM del jefe es el único contexto con
acceso a su memoria/notas** (en grupos Juanito va aislado).

> **En una línea:** el **equipo técnico (admin)** opera Juanito con los comandos `/`; el **jefe**
> no aprende sintaxis — aprueba y pide cosas hablándole normal por WhatsApp.

---

## ⭐ Confirmaciones antes de enviar — `/confirmaciones`

Controla cuándo Juanito necesita **tu visto bueno** antes de que un mensaje salga. Hay dos planos:

- **Por grupo** (menciones en grupos): se activa **grupo por grupo**.
- **DMs de desconocidos**: un **único toggle global** (todos los DMs o ninguno).

Cuando una confirmación está activa, Juanito **no envía**: te manda la propuesta por DM y tú decides.
Las propuestas **caducan a los 30 min** sin decisión (configurable con `REPLY_APPROVAL_TTL_MIN`).

| Comando | Qué hace |
|---|---|
| `/confirmaciones` | Muestra el estado: DM (ON/OFF) + lista de grupos con confirmación ON |
| `/confirmaciones dm on` | **Todos** los DMs de desconocidos pasan por tu aprobación |
| `/confirmaciones dm off` | Juanito responde los DMs directo (default) |
| `/confirmaciones grupo <n\|nombre> on` | Ese grupo exige tu visto bueno antes de responder |
| `/confirmaciones grupo <n\|nombre> off` | Ese grupo vuelve a responder directo (default) |

`<n|nombre>` = número de la lista de `/grupos`, o parte del nombre del grupo (ej: `Automatiza`).

**Ejemplo (el caso del jefe):**
```
/confirmaciones grupo Automatizaciones on     → ese grupo te pide confirmación
/confirmaciones grupo Volunteers off          → Volunteers responde directo (no molesta)
/confirmaciones dm on                         → cada DM de cualquiera te llega para aprobar
/confirmaciones                               → ver cómo quedó todo
```

> **Default seguro:** todo arranca en **OFF** → si nunca activas nada, Juanito responde directo como
> siempre. Sólo lo que actives explícitamente pasa por ti.

**Alias retro-compatible:** `/aprobar_grupo <n|nombre> on|off` hace lo mismo que
`/confirmaciones grupo …` (se mantiene por memoria muscular).

### Cómo aprobar lo que te llega (jefe)

Cuando una confirmación está activa, Juanito te escribe por DM algo como:

```
📨 Respuesta pendiente #7 para el DM de Pedro
Pedro escribió: "¿hacen automatizaciones de WhatsApp?"
Propongo responder: Sí, justo eso hacemos…
Responde "apruebo" para que salga, dime los cambios, o "no" para descartarla.
```

Le respondes **en lenguaje natural**, sin comandos ni ids:

- **Aprobar:** "apruebo", "envíala", "dale", "está bien" → sale en ≤1 min (citando el mensaje original).
- **Corregir:** "más corto", "dile que el martes", "cámbiala" → la regenera y te la muestra de nuevo.
- **Rechazar:** "no", "no respondas", "descártala" → no se envía.

Esto aplica **igual** a respuestas de grupo y a DMs.

### Verlas/gestionarlas como admin — `/respuestas`

| Comando | Qué hace |
|---|---|
| `/respuestas` | Lista las respuestas pendientes (grupo **y** DM) con su estado |
| `/respuestas ver <id>` | Muestra el texto completo + contexto |
| `/respuestas aprobar <id>` | Override: la envía en el próximo minuto |
| `/respuestas rechazar <id>` | La descarta |

---

## Órdenes del jefe para el equipo — `/tareas` *(admin)*

Cuando el jefe le pide a Juanito algo que **ninguna de sus herramientas puede hacer** (subir algo a
una hoja nueva, una gestión manual, etc.), Juanito **no se niega**: anota la orden y avisa al equipo
(al grupo de aprobaciones si está configurado, o al DM del jefe). El jefe recibe un "se lo paso al
equipo y te confirmo en cuanto esté".

| Comando | Qué hace |
|---|---|
| `/tareas` | Lista las órdenes pendientes del jefe (id + texto) |
| `/tareas ver <id>` | Detalle completo (orden + contexto + quién la pidió) |
| `/tareas hecha <id>` | La cierra y **avisa al jefe** ("✅ Listo lo que pediste…") |
| `/tareas descartar <id>` | La descarta (sin avisar a nadie) |

---

## Grupos — `/grupos` y `/grupo`

Juanito **solo responde en grupos autorizados** (anti-secuestro, default-deny).

| Comando | Dónde | Qué hace |
|---|---|---|
| `/grupos` | DM *(admin)* | Lista numerada de todos los grupos + su estado (✅ autorizado / ⛔ no) |
| `/grupos on <n\|nombre>` | DM *(admin)* | Habilita a Juanito para responder en ese grupo |
| `/grupos off <n\|nombre>` | DM *(admin)* | Revoca y Juanito **se sale** del grupo |
| `/grupo` | en el grupo | Muestra si está habilitado aquí |
| `/grupo on` | en el grupo *(jefe/admin)* | Habilita a Juanito en este grupo |
| `/grupo off` | en el grupo *(jefe/admin)* | Lo deshabilita y se sale |

---

## Personalidad por grupo — `/persona` *(admin)*

Define el tono con el que Juanito responde en un grupo concreto (se inyecta en su prompt).

| Comando | Qué hace |
|---|---|
| `/persona` | Lista las personalidades configuradas |
| `/persona <n\|nombre>` | Muestra la personalidad de ese grupo |
| `/persona <n\|nombre> \| <texto>` | Define la personalidad (el texto queda **exacto**) |
| `/persona <n\|nombre> off` | La elimina (vuelve al tono genérico) |

Ejemplo: `/persona Patah | Grupo católico. Tono cercano a la fe; di "muchachos".`

---

## Mensajes recurrentes a grupos — `/programados` *(admin)*

Ver/cancelar los mensajes que Juanito envía de forma recurrente a un grupo. **Crearlos** es por
lenguaje natural en el DM del jefe ("manda cada jueves a las 8pm al grupo X…").

| Comando | Qué hace |
|---|---|
| `/programados` | Lista los mensajes recurrentes activos (días + hora) |
| `/programados off <id>` | Cancela uno |

Los mensajes **generados** (Claude redacta cada día según un brief) pasan por aprobación: ver
`/aprobaciones`.

---

## Aprobación de mensajes generados — `/aprobaciones` *(admin)*

Estado y override del flujo de los **mensajes programados generados** (los que Claude redacta cada
día y el jefe aprueba por DM antes de publicarse).

| Comando | Qué hace |
|---|---|
| `/aprobaciones` | Borradores de hoy con su estado (⏳ pendiente / ✅ aprobado / 📤 publicado / 🗑️) |
| `/aprobaciones ver <id>` | Texto completo del borrador |
| `/aprobaciones aprobar <id>` | Override: lo aprueba (normalmente lo hace el jefe por DM) |
| `/aprobaciones rechazar <id>` | Lo descarta: no se publica hoy |

---

## Calendly (recordatorios precall) — `/calendly` *(admin)*

Botón de pánico de los pushes a closers.

| Comando | Qué hace |
|---|---|
| `/calendly` | Estado global + closers pausados |
| `/calendly off` | Pausa **todos** los pushes (global) |
| `/calendly on` | Reactiva los pushes |
| `/calendly off <closer>` | Pausa solo a ese closer (nombre completo, ej: `Pablo Lozano`) |
| `/calendly on <closer>` | Reactiva solo a ese closer |

> ⚠️ **`/calendly off` a secas es GLOBAL y apaga a TODAS las empresas**, no solo a una. Juanito
> puede atender varias cuentas de Calendly (una por agencia). Para cortarle a una sola, usá
> `/calendly off <closer>` uno por uno. Un `/calendly off <empresa>` está pendiente.

> `<closer>` va con **nombre completo**. Un closer registrado solo con nombre de pila no se
> reconoce acá (es a propósito: un nombre de una palabra es ambiguo y podría apuntar a la persona
> equivocada).

---

## Registro de calls — lo que responde el **closer** (sin comandos)

Después de cada call, Juanito le escribe al closer y le pregunta cómo le fue. El closer
responde con un número o en lenguaje natural; no abre ninguna hoja.

```
📋 Registro de call — Ana Pérez (de las 9:00 a. m.)
   1️⃣ Show   2️⃣ No show   3️⃣ Reagendó
```

- **1 · Show** → Juanito pregunta el resultado (venta cerrada / acuerdo verbal / seguimiento / no cerró).
- **2 · No show** → cierra ahí.
- **3 · Reagendó** → Juanito pregunta **para cuándo** (`hoy 3pm`, `mañana 10:30am`, `22/07 9am`).
  Con esa fecha **agenda solo** el recordatorio precall y el registro de la call nueva — **también si la
  reagenda se hizo por otro link, fuera de Calendly**. Si aún no hay fecha, el closer dice *"aún no sé"* y
  Juanito le vuelve a preguntar al día siguiente.

**En las métricas:** una call reagendada o cancelada **no cuenta** como call (no ocurrió). Aparece en la
línea `🔁 movidas` del reporte, y el lead cuenta **una sola vez**: el día que la call de verdad se hizo.

---

## Reporte de leads — `/reporte` *(admin)*

| Comando | Qué hace |
|---|---|
| `/reportes` / `/reportes leads` | Reporte de **leads** del Sheet **ahora**. En DM = preview; **dentro de un grupo autorizado** (jefe/admin) lo **publica en ese grupo** |
| `/reportes metricas` | Reporte de **métricas de desempeño** ahora. En DM = preview; **en un grupo** (jefe/admin) lo **publica ahí** ⚠️ (las métricas quedan visibles para todo el grupo). Alias: `/metricas` |

---

## Diagnóstico e identidad

| Comando | Quién | Qué hace |
|---|---|---|
| `/status` | *(admin)* | Estado del sistema: WhatsApp, uptime, Calendly token, DRY_RUN, opt-ins, salud de jobs |
| `/help` / `/ayuda` / `/comandos` | cualquiera | Ayuda **según tu rol**: el equipo ve los comandos; el jefe ve "háblame normal"; un desconocido, un saludo |
| `/whoami` / `/id` | cualquiera | Devuelve tu JID/LID y tu rol (útil para configurar un admin nuevo) |

---

## Resumen rápido (cheat sheet)

```
/confirmaciones                          ← estado de las confirmaciones
/confirmaciones dm on|off                ← confirmar TODOS los DMs (global)
/confirmaciones grupo <n|nombre> on|off  ← confirmar un grupo
/respuestas [ver|aprobar|rechazar <id>]  ← pendientes (grupo + DM)
/tareas [ver|hecha|descartar <id>]       ← órdenes del jefe por hacer
/grupos [on|off <n|nombre>]              ← autorizar/listar grupos
/grupo [on|off]                          ← (dentro del grupo)
/persona <n|nombre> | <texto>            ← tono por grupo
/programados [off <id>]                  ← recurrentes
/aprobaciones [ver|aprobar|rechazar <id>]← borradores generados
/calendly [on|off] [closer]              ← pushes precall
/reportes [leads|metricas]               ← reporte (DM=preview · en grupo lo publica)
/status · /whoami · /id                  ← diagnóstico e identidad
/help · /ayuda · /comandos               ← ayuda según tu rol
```
