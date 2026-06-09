# Juanito — Hand-off y estado del producto

Documento vivo: resume cómo funciona Juanito como asistente de WhatsApp,
qué decisiones de diseño se tomaron, qué está pendiente de probar, y qué
features están planeadas. Actualizar cada vez que se haga un cambio importante.

---

## ⏳ Pruebas pendientes de confirmar

Pruebas que quedaron incompletas durante la sesión de testing del 2026-06-08.
Ejecutar antes de entregar a producción real.

| # | Prueba | Qué verificar |
|---|--------|--------------|
| E4 | Rate limit se reinicia al día siguiente | @mention 5 veces el día anterior, al día siguiente debe volver a responder |
| E5 | BOSS ilimitado en grupos | BOSS usa @Juanito más de 5 veces en un grupo — debe responder todas |

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

### [MEJORA] Juanito saluda a los ADMINs por nombre
**Qué:** Hoy el jefe puede decirle a Juanito su nombre vía DM ("recuerda que me llamo X")
y Juanito lo guarda con `remember_note` y lo usa. Para los ADMINs no existe esa
memoria personal sandboxed — sus interacciones usan la misma memoria núcleo.
Implementar una memoria de notas por-admin similar a la del jefe (`admin_note:<lid>:<key>`)
para que cada miembro del equipo pueda personalizar cómo lo llama Juanito.

**Archivos a tocar:**
- `src/claude/index.js` — nuevo prefijo `ADMIN_NOTE_PREFIX`, nuevo tool `admin_note`
  (solo visible cuando `role === 'admin'`), splitMemory extendido para leer notas del admin activo

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
