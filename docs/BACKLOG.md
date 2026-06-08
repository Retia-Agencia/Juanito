# Backlog de Juanito — Features y mejoras pendientes

Ideas y features que quedaron fuera del alcance inicial pero están documentadas
para cuando se retome el desarrollo. Ordenadas por impacto estimado.

---

## 🔴 Alta prioridad

### [FEATURE] Memoria específica por grupo
**Qué:** Permitir que un admin asigne "memoria contextual" a un grupo concreto.
Hoy, Juanito responde en grupos como chatbot genérico sin saber nada del grupo.
La idea es poder decirle: *"en el grupo Ventas, sabe que el producto principal es X,
el equipo son Y y Z, y el objetivo mensual es W"*, y que Juanito use eso como
contexto cuando alguien le hace una @mención en ese grupo.

**Cómo implementarlo:**
- Nueva tabla en SQLite: `group_memory(group_id TEXT PRIMARY KEY, context TEXT, updated_at)`
- Nuevo tool para admin/boss: `set_group_context(group_id, context)` y `get_group_context(group_id)`
- En `buildSystemPrompt()` (`src/claude/index.js`): si `isGroup=true` y existe una
  entrada para `chatId` en `group_memory`, inyectarla como un bloque
  `## Contexto de este grupo\n${context}` en el prompt.
- Comando de admin para configurarlo desde WhatsApp:
  `"recuerda sobre el grupo [nombre]: [contexto]"` → Claude invoca `set_group_context`

**Archivos a tocar:**
- `src/db/migrate.js` — nueva tabla `group_memory`
- `src/db/index.js` — `setGroupMemory(groupId, context)` + `getGroupMemory(groupId)`
- `src/claude/index.js` — nuevo tool + inyección en `buildSystemPrompt` + pasar `chatId` al builder
- `src/bot/index.js` — pasar `chatId` al llamado de `chat()` en `handleGroupMessage`

---

## 🟡 Media prioridad

### [MEJORA] Comando `/admins` para listar admins activos
**Qué:** Desde un DM de admin, listar los LIDs configurados en `ADMIN_LID` y
a qué contacto corresponden (si están en la tabla `contacts`).
Útil para auditar quién tiene acceso sin tener que leer el `.env` del VPS.

### [MEJORA] Capturar y persistir el LID del jefe automáticamente
**Qué:** Hoy `BOSS_LID` se configura manualmente en el `.env`. Sería mejor que
cuando el jefe manda el primer DM y su LID es reconocido por `BOSS_PHONE`,
el sistema lo guarde en la DB y lo use como identificador canónico en adelante.
Elimina la necesidad de leer logs para obtener el LID.

### [MEJORA] Rate limit configurable por grupo
**Qué:** Hoy `GROUP_DAILY_LIMIT` es global para todos los grupos. Poder
configurar un límite diferente por grupo (ej: grupo de ventas = 20/día,
grupo de soporte = 5/día).

---

## 🟢 Baja prioridad / Nice-to-have

### [FEATURE] Comando `/recuerda` en grupos (para admins)
**Qué:** Que un admin pueda escribir en un grupo:
`@Juanito /recuerda [texto]` para guardar un hecho en la memoria núcleo
directamente desde el grupo, sin tener que ir a un DM.

### [MEJORA] Resumen on-demand de grupos
**Qué:** Hoy los resúmenes se generan automáticamente cada 4h. Que el jefe pueda
pedir `"¿qué pasó hoy en el grupo X?"` y Juanito genere uno al instante con
`summarize_group`, sin esperar el cron.
(Parcialmente funciona hoy — el tool `summarize_group` ya existe, pero no está
expuesto explícitamente en el prompt del jefe como una opción.)

### [MEJORA] Personalización del tono por grupo
**Qué:** En grupos más formales (ej: clientes) que Juanito use un tono más formal;
en grupos internos, más relajado. Configurable con `set_group_context`.
