---
name: Auditoría Comercial — Especificación V2.3
description: Comando "auditoría del día" para directores de programa. Muestra reuniones del día por comercial, qué pasó con cada una, validación de protocolo deal-por-deal, y correcciones específicas. Usa REST search + GET (detalle individual, no agregados SQL).
---

# Comando: Auditoría del Día — Especificación V2.3

## Activación

Cualquiera de estas frases activa la auditoría:

- `auditoría del día [programa]`
- `auditoría [programa]`
- `reuniones del día [programa]`
- `¿cómo les fue hoy? [programa]`
- `¿qué pasó con las reuniones de [programa]?`
- `reporte reuniones [programa]`
- `¿cómo le fue a [nombre del comercial]?` ← drill-down a un solo comercial

Si el usuario dice "todos" o no especifica programa y es Apelis o Danilo → mostrar resumen multi-programa primero, luego drill-down.

---

## Diferencia con Reporte Día

| Aspecto | `reporte día` | `auditoría del día` |
|---------|---------------|---------------------|
| Nivel | Macro → micro (dashboard + métricas) | Micro → deal-por-deal |
| Foco | Pipeline completo, scorecard, alertas | Reuniones + protocolo por comercial |
| Motor | SQL (`query_crm_data`) + REST (tags) | REST search + GET (detalle individual) |
| Audiencia | Director ve el panorama | Director ve la ejecución del comercial |
| Uso típico | Inicio del día, revisión general | Fin del día, validación de cumplimiento |

---

## Flujo de Ejecución

```
1. Usuario indica programa (o "todos")
   ↓
2. Obtener owners del pipeline (excluir cuentas-pool)
   ↓
3. Obtener reuniones del día para esos owners
   ↓
4. Obtener deals en etapas activas (Agendado → CV/Reservado)
   ↓
5. Cruzar: reuniones ↔ deals ↔ propiedades condicionales
   ↓
6. Validar protocolo por deal
   ↓
7. Formatear por comercial → entregar
```

---

## Queries

### QA-1 — Reuniones del día (REST search)

```json
{
  "objectType": "meetings",
  "filterGroups": [{
    "filters": [
      { "propertyName": "hs_meeting_start_time", "operator": "GTE", "value": "{START_OF_DAY_MS}" },
      { "propertyName": "hs_meeting_start_time", "operator": "LTE", "value": "{END_OF_DAY_MS}" }
    ]
  }],
  "properties": [
    "hs_meeting_title", "hs_meeting_start_time", "hs_meeting_end_time",
    "hs_meeting_outcome", "hubspot_owner_id", "hs_internal_meeting_notes"
  ],
  "limit": 100
}
```

**Timestamps:** America/Bogota (UTC-5). Inicio del día = 05:00:00 UTC. Fin = 04:59:59 UTC del día siguiente. Convertir a milisegundos epoch.

**Resultados:** Filtrar por owner (excluir cuentas-pool). Agrupar por owner.

### QA-2 — Asociar reuniones a deals

Para cada reunión del paso anterior:
```
GET /crm/v3/objects/meetings/{MEETING_ID}/associations/deals
```

Esto devuelve los deals vinculados a esa reunión. Con el deal ID puedes:
- Verificar en qué pipeline/etapa está
- Filtrar por el programa solicitado
- Obtener propiedades condicionales

### QA-3 — Detalle de cada deal vinculado

```
GET /crm/v3/objects/deals/{DEAL_ID}
properties: dealname, dealstage, pipeline, amount, hubspot_owner_id,
            agenda_status, agenda_change,
            resultado_del_intento_de_contacto, resultado_del_contacto_logrado,
            califica_para_el_programa, resultado_de_la_calificacion,
            meeting_result_completed, estado_de_negociacion,
            closed_lost_reason_category, motivo_de_descualificacion,
            motivo_de_perdida_de_venta, fecha_de_agenda,
            hs_v2_date_entered_current_stage, notes_last_contacted,
            notes_next_activity_date, createdate
```

> ⚠️ **Nombres de propiedades:** Algunos pipelines pueden usar nombres alternativos internos (ej. `estado_de_la_agenda` vs `agenda_status`). Si una propiedad devuelve null, probar con el nombre alternativo. Las propiedades estándar son las listadas arriba.

### QA-4 — Deals en etapa activa SIN reunión hoy (complementario)

Para detectar deals que deberían tener actividad pero no la tienen:

```json
{
  "objectType": "deals",
  "filterGroups": [{
    "filters": [
      { "propertyName": "pipeline", "operator": "EQ", "value": "{PIPELINE_ID}" },
      { "propertyName": "dealstage", "operator": "IN", "values": ["{AGENDADO_ID}", "{ATENDIDO_ID}", "{CV_ID}"] },
      { "propertyName": "hubspot_owner_id", "operator": "EQ", "value": "{OWNER_ID}" }
    ]
  }],
  "properties": [
    "dealname", "dealstage", "amount",
    "agenda_status", "agenda_change",
    "meeting_result_completed", "estado_de_negociacion",
    "hs_v2_date_entered_current_stage", "notes_last_contacted",
    "fecha_de_agenda"
  ],
  "limit": 50
}
```

Ejecutar por cada owner activo. Esto complementa las reuniones con deals que pueden estar estancados.

### QA-5 — Contacto asociado al deal (para nombre legible)

```
GET /crm/v3/objects/deals/{DEAL_ID}/associations/contacts
→ GET /crm/v3/objects/contacts/{CONTACT_ID}?properties=firstname,lastname,email,phone
```

---

## Reglas de Validación de Protocolo

Para cada deal, validar según su etapa actual. Las propiedades condicionales del protocolo son las que disparan los workflows de avance automático.

### Etapa: Agendado / Reunión agendada

| Propiedad | Regla | Flag si |
|-----------|-------|---------|
| `agenda_status` | Debe reflejar la realidad | = "Programada" pero el deal lleva >2 días en la etapa |
| `agenda_status` | Si reunión ya pasó | Sigue en "Programada" → debería ser "Terminada" o "No asistió" |
| `agenda_change` | Si `agenda_status` = "No asistió" o "Cancelada" | Vacío → debería indicar "Reprogramar", "Descartar" o "Intento de contacto" |
| `fecha_de_agenda` | Fecha de la reunión | Vacía o en el pasado sin resultado |

**Regla de 3 intentos:** Si el comercial reporta 3+ intentos de contacto fallidos, el deal debería moverse a Cierre perdido con motivo "Sin respuesta" o "No-show".

### Etapa: Atendido / Reunión ocurrida

| Propiedad | Regla | Flag si |
|-----------|-------|---------|
| `agenda_status` | La reunión ocurrió | ≠ "Terminada" |
| `meeting_result_completed` | Resultado de la reunión | Vacío → debería ser "Interesado", "Reservado", "Comprometido" o "No interesado" |

**Si `meeting_result_completed` está vacío:** El deal avanzó de etapa pero el comercial no registró el resultado. Flag como incompleto.

### Etapa: Compromiso Verbal / En negociación

| Propiedad | Regla | Flag si |
|-----------|-------|---------|
| `estado_de_negociacion` | Estado actual de la negociación | Vacío → debería ser "Revisando propuesta", "Reservado" o "Descartado" |
| `agenda_status` | La reunión previa ya terminó | ≠ "Terminada" |
| `meeting_result_completed` | Resultado de la reunión que llevó aquí | Vacío |

### Etapa: Cierre perdido

| Propiedad | Regla | Flag si |
|-----------|-------|---------|
| `closed_lost_reason_category` | Motivo de cierre | Vacío → obligatorio |
| `motivo_de_descualificacion` | Si aplica (no-show, sin respuesta, no fit) | Vacío cuando debería estar |

### Resumen de flags

| Símbolo | Significado |
|---------|-------------|
| ✅ | Deal correctamente actualizado — etapa y propiedades alineadas |
| ⚠️ | Parcialmente correcto — etapa OK pero faltan propiedades condicionales |
| ❌ | Mal actualizado — etapa incorrecta o propiedades críticas vacías |
| 🔴 | Acción urgente — deal debería estar en Cierre perdido o tiene >3 intentos fallidos |

---

## Formato de Salida

### Vista resumen (si "todos" o múltiples programas)

```
📋 AUDITORÍA DEL DÍA — TODOS LOS PROGRAMAS — [Fecha]

┌────────────────────────┬───────────┬────────────┬──────────┬──────────┐
│ Programa               │ Reuniones │ Asistidas  │ No-shows │ Sin dato │
├────────────────────────┼───────────┼────────────┼──────────┼──────────┤
│ Multipliers            │     8     │     6      │    1     │    1     │
│ 30X Executive          │     5     │     3      │    1     │    1     │
│ AI for Executives      │     3     │     3      │    0     │    0     │
├────────────────────────┼───────────┼────────────┼──────────┼──────────┤
│ TOTAL                  │    16     │    12      │    2     │    2     │
└────────────────────────┴───────────┴────────────┴──────────┴──────────┘

⚠️ 7 deals con propiedades pendientes de actualizar
🔴 2 deals deberían estar en Cierre perdido

¿Cuál programa quieres ver en detalle?
```

### Vista detallada (un programa)

```
📋 AUDITORÍA DEL DÍA — [Programa] — [Fecha]

═══════════════════════════════════════════════════════
👤 [NOMBRE DEL COMERCIAL] — [N] reuniones hoy
═══════════════════════════════════════════════════════

📅 REUNIONES DEL DÍA:

1️⃣ [Nombre del contacto] — [email]
   🕐 Hora: [HH:MM] AM/PM
   📊 Resultado reunión: [Asistió ✅ / No asistió ❌ / Cancelada / Sin dato ⚠️]
   📁 Deal: [nombre del deal] | Etapa: [etapa actual]
   
   🔍 VALIDACIÓN DE PROTOCOLO:
   ├── agenda_status: [valor actual] → [valor esperado] [✅/❌]
   ├── meeting_result_completed: [valor actual] → [valor esperado] [✅/❌]
   └── Etapa correcta: [etapa esperada] [✅/❌]
   
   💡 Correcciones necesarias:
   • Cambiar `agenda_status` de "Programada" a "Terminada"
   • Llenar `meeting_result_completed` → "Interesado"
   • Mover deal de "Agendado" a "Atendido"

2️⃣ [Siguiente contacto]...

───────────────────────────────────────────────────────
📊 DEALS EN ETAPAS ACTIVAS SIN REUNIÓN HOY:

   ⚠️ [Deal X] — Agendado hace 5 días — agenda_status: "Programada"
      → ¿Se agendó reunión? Si no, considerar intento de contacto o descarte
   
   🔴 [Deal Y] — Agendado hace 8 días — 0 actividad registrada
      → Supera tiempo razonable. Mover a Cierre perdido o contactar hoy.

───────────────────────────────────────────────────────
📊 RESUMEN [COMERCIAL]:
   Reuniones programadas: [N]
   Reuniones asistidas: [N] | No-shows: [N] | Sin dato: [N]
   Deals correctamente actualizados: [N]/[total] ([%])
   Propiedades pendientes: [N]
   ⚠️ Patrón detectado: [descripción del patrón si existe]

═══════════════════════════════════════════════════════
👤 [SIGUIENTE COMERCIAL]...
═══════════════════════════════════════════════════════

[Repetir estructura]

───────────────────────────────────────────────────────
📊 RESUMEN GLOBAL DEL EQUIPO:
┌──────────────┬──────────┬──────────┬──────────┬─────────┬──────────┐
│ Comercial    │ Reuniones│ Asistidas│ Deals OK │ Pend.   │ Flag     │
├──────────────┼──────────┼──────────┼──────────┼─────────┼──────────┤
│ Victoria     │    3     │    2     │   0/3    │   6     │   🔴     │
│ JJ           │    5     │    5     │   4/5    │   1     │   ✅     │
│ Dana         │    2     │    1     │   1/2    │   2     │   ⚠️     │
├──────────────┼──────────┼──────────┼──────────┼─────────┼──────────┤
│ TOTAL        │   10     │    8     │   5/10   │   9     │          │
└──────────────┴──────────┴──────────┴──────────┴─────────┴──────────┘
```

### Vista individual (un comercial)

Cuando el usuario pregunta `¿cómo le fue a Victoria?`:
1. Buscar owner por nombre (GET /crm/v3/owners)
2. Mostrar la sección de ese comercial completa (reuniones + deals activos + resumen)
3. Al final ofrecer: "¿Quieres ver otro comercial o el equipo completo?"

---

## Detección de Patrones

Al analizar un comercial, buscar patrones recurrentes y reportarlos:

| Patrón | Cómo detectar | Mensaje |
|--------|---------------|---------|
| No actualiza propiedades | Múltiples deals con propiedades vacías | "Patrón: No llena propiedades condicionales después de reuniones" |
| Deals estancados en Agendado | >3 deals en Agendado con >3 días | "Patrón: Deals se acumulan en Agendado sin avance" |
| No-shows sin descarte | Deals con no-show pero sin mover a Cierre perdido | "Patrón: No descarta prospectos que no asisten" |
| Sin actividad reciente | Owner con 0 llamadas + 0 reuniones hoy y deals activos | "Patrón: Sin actividad registrada hoy con [N] deals activos" |

---

## Optimización de Queries

### Para un programa (caso típico: director)

| Paso | Query | Calls API |
|------|-------|-----------|
| 1 | GET owners | 1 |
| 2 | Search meetings del día | 1 |
| 3 | Associations meeting→deal | N (= reuniones) |
| 4 | GET deal detail | N (= deals únicos) |
| 5 | GET contact per deal | N (= deals, para nombre) |
| 6 | Search deals en Agendado/Atendido/CV por owner | M (= owners activos) |
| **Total** | | ~3N + M + 2 |

Para un día típico con 10 reuniones y 4 comerciales: ~35 calls. Dentro de rate limit.

### Para todos los programas (Apelis/Danilo)

1. Buscar TODAS las reuniones del día (1 call, limit 200)
2. Agrupar por owner → programa (via deal association)
3. Mostrar resumen multi-programa
4. Drill-down bajo demanda (solo el programa seleccionado)

**No ejecutar el detalle de todos los programas de golpe** — demasiadas calls. Mostrar resumen primero, detalle bajo demanda.

---

## Notas Importantes

1. **Reuniones fuera de HubSpot:** No todas las reuniones se crean como objetos en HS (algunas se agendan por Calendly/Cal.com sin integración). Si un deal está en "Agendado" pero no tiene reunión en HS, no significa que no haya reunión — puede estar en otro sistema.

2. **Fecha flexible:** Si el usuario dice "ayer" o "el lunes", ajustar las fechas de las queries. El default es hoy.

3. **Stage IDs:** Usar las tablas de `02_KNOWLEDGE_PIPELINE_DEALS.md` para mapear stage IDs a nombres. Cada programa tiene sus propios stage IDs.

4. **Etapas equivalentes para la auditoría:**

| Concepto | Variante A (estándar) | Variante B (Multipliers) |
|----------|----------------------|--------------------------|
| Reunión pendiente | Agendado | Reunión agendada |
| Reunión completada | Atendido | Reunión ocurrida |
| En negociación | Compromiso Verbal | En negociación |

5. **Cuentas-pool:** Excluir siempre de la auditoría (IDs: `90090091, 89422210, 90185405, 90154136, 90056486, 90154155`). Son carga masiva, no comerciales reales.

6. **Combinación con reporte día:** Un director puede pedir primero el `reporte día` (macro) y luego la `auditoría` (micro) para profundizar en un comercial específico. Son complementarios.
