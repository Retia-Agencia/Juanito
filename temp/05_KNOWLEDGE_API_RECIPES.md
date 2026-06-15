---
name: Recetas API — HubSpot
description: Motor de datos SQL (query_crm_data con GROUP BY) + recetas individuales para deals, contactos HVM, leads y meetings. Sin paginación. Desatendidos por tag oficial. HVM vive en contacto, no en deal.
---

# Recetas API — HubSpot para el Agente Comercial 30X V2.2

Conexión: HubSpot MCP (autenticación automática).

---

## Motor de datos — query_crm_data con GROUP BY

> **Regla:** Para pipelines con cientos/miles de deals, NUNCA paginar de a 100.
> Usar `query_crm_data` con sentencias SQL que agregan en servidor.
> Total de queries por reporte: 6-7 (vs 200+ con paginación).

### Q1 — Deals por etapa (base del reporte)

```sql
SELECT dealstage,
       COUNT(*) AS deals,
       SUM(amount) AS valor
FROM DEAL
WHERE pipeline = '{PIPELINE_ID}'
GROUP BY dealstage
```

Devuelve una fila por etapa con cantidad y valor total. Con esto armas §1 y §2.

### Q2 — Cross-tab owner × etapa

```sql
SELECT hubspot_owner_id, dealstage,
       COUNT(*) AS deals,
       SUM(amount) AS valor
FROM DEAL
WHERE pipeline = '{PIPELINE_ID}'
GROUP BY hubspot_owner_id, dealstage
```

Base para §3 (Gestión por Comercial) y scorecard. Una sola query te da todo.

### Q3 — Ganados y perdidos hoy

```sql
SELECT dealstage, COUNT(*) AS deals, SUM(amount) AS valor
FROM DEAL
WHERE pipeline = '{PIPELINE_ID}'
  AND closedate BETWEEN '{YYYY-MM-DD}' AND '{YYYY-MM-DD}'
GROUP BY dealstage
```

Usar fechas string `'YYYY-MM-DD'` (ej. `'2026-06-09'`). El motor SQL de `query_crm_data` NO acepta epoch en milisegundos — eso es solo para las recetas REST (`search_crm_objects`).

### Q4 — Cohortes disponibles (main_sku)

```sql
SELECT main_sku, COUNT(*) AS deals
FROM DEAL
WHERE pipeline = '{PIPELINE_ID}'
GROUP BY main_sku
```

### Q5 — GESTIÓN del día (V2.2) — actividad real (A) + avance de protocolo (P)

> ⚠️ **Cambio V2.2:** `notes_last_contacted` quedó **deprecada** como métrica de gestión (la mueven notas y bots). La gestión se mide con actividad real (llamadas/reuniones) **o** avance de protocolo. Ver definición completa en `01_SYSTEM_PROMPT.md`.

#### Q5-A — Actividad real: LLAMADAS por owner × programa

```sql
SELECT hubspot_owner_id, DEAL.pipeline, COUNT(*)
FROM CALL
WHERE hs_timestamp BETWEEN '{YYYY-MM-DD}' AND '{YYYY-MM-DD}'
GROUP BY hubspot_owner_id, DEAL.pipeline
```

#### Q5-B — Actividad real: REUNIONES por owner × programa

```sql
SELECT hubspot_owner_id, DEAL.pipeline, COUNT(*)
FROM MEETING_EVENT
WHERE hs_timestamp BETWEEN '{YYYY-MM-DD}' AND '{YYYY-MM-DD}'
GROUP BY hubspot_owner_id, DEAL.pipeline
```

**Actividad real (A) por owner/programa = Q5-A + Q5-B.**

Notas:
- Usa el cruce `DEAL.pipeline` (objeto asociado). Las filas con pipeline `Unassigned` son actividades huérfanas (sin deal) → **exclúyelas** del conteo por programa.
- ❌ **NO consultes `NOTE`** (automatización las crea) ni **`TASK`** como gestión (creación masiva por bot, 1,000+/día). Si el usuario las pide, query aparte y márcalas como ruido, NO como gestión.
- ⚠️ **`EMAIL`**: el cruce `EMAIL → DEAL.pipeline` **falla** en el motor (error interno). Para volumen sin programa:
  ```sql
  SELECT hubspot_owner_id, COUNT(*) FROM EMAIL
  WHERE hs_timestamp BETWEEN '{YYYY-MM-DD}' AND '{YYYY-MM-DD}'
  GROUP BY hubspot_owner_id
  ```
  Repórtalo como referencia por owner, sin atribuir a un programa.

#### Q5-C — Avance de protocolo (P): movimientos por etapa de destino

```sql
SELECT dealstage, hubspot_owner_id, COUNT(*)
FROM DEAL
WHERE hs_v2_date_entered_current_stage BETWEEN '{YYYY-MM-DD}' AND '{YYYY-MM-DD}'
GROUP BY dealstage, hubspot_owner_id
```

> ⚠️ El motor de reporting soporta **máximo 2 dimensiones en GROUP BY**. Por eso se agrupa por `dealstage` (que YA identifica el pipeline por su Stage ID) y `hubspot_owner_id`. Si reportas un solo programa, añade `AND pipeline = '{PIPELINE_ID}'` al WHERE.

Procesamiento:
1. Cruza cada `dealstage` (Stage ID) con las tablas de `02_KNOWLEDGE_PIPELINE_DEALS.md` → obtén pipeline + etapa + **clase** (sección 3.5).
2. **Avance de protocolo (P)** de un comercial = suma de deals que entraron a etapas de clase ✅ (Trabajo/decisión, Venta, Descarte).
3. **Descarta** del conteo P las clases ❌ (Potencial, Registrado, En gestión, Ganado Pagado Completo).

#### Cómo combinar A y P

- Repórtalas en **columnas separadas**: `A (llamadas+reuniones)` y `P (avances protocolo)`.
- **NO las sumes** como deals únicos sin deduplicar (un deal puede tener ambas).
- Un comercial está en 🔴 "sin gestión" solo si **A = 0 y P = 0** (y advertir el punto ciego de propiedad-sin-movimiento antes de afirmarlo).

### Q6 — Desatendidos por owner (search_crm_objects, NO SQL)

> ⚠️ `query_crm_data` no soporta filtrar por tags (`hs_tag_ids` es multi-valor concatenado).
> Los desatendidos por owner se sacan con `search_crm_objects`, un call por comercial activo.

**Para cada owner activo** (excluir cuentas-pool), ejecutar:

```json
{
  "objectType": "deals",
  "filterGroups": [{
    "filters": [
      { "propertyName": "pipeline", "operator": "EQ", "value": "{PIPELINE_ID}" },
      { "propertyName": "hubspot_owner_id", "operator": "EQ", "value": "{OWNER_ID}" },
      { "propertyName": "hs_tag_ids", "operator": "CONTAINS_TOKEN", "value": "25397556" }
    ]
  }],
  "limit": 1
}
```

Leer solo el campo `total` de la respuesta → es el conteo de desatendidos de ese owner. NO paginar.

Con ~5-8 comerciales activos = 5-8 llamadas rápidas (una por owner).

> **DESATENDIDO = tag `25397556`**. Es la fuente autoritativa. NO usar heurística de `notes_last_contacted > 2d`.

**Para cuentas-pool (total agregado):**

```json
{
  "filterGroups": [{
    "filters": [
      { "propertyName": "pipeline", "operator": "EQ", "value": "{PIPELINE_ID}" },
      { "propertyName": "hubspot_owner_id", "operator": "IN", "values": ["90090091","89422210","90185405","90154136","90056486","90154155"] },
      { "propertyName": "hs_tag_ids", "operator": "CONTAINS_TOKEN", "value": "25397556" }
    ]
  }],
  "limit": 1
}
```

### Q7 — Conteo por etiqueta (5 búsquedas rápidas con search_crm_objects)

Mismo caso que Q6: tags requieren `search_crm_objects` con `CONTAINS_TOKEN`, no SQL.

Para cada tag, una búsqueda leyendo solo `total`:

```json
{
  "filterGroups": [{
    "filters": [
      { "propertyName": "pipeline", "operator": "EQ", "value": "{PIPELINE_ID}" },
      { "propertyName": "hs_tag_ids", "operator": "CONTAINS_TOKEN", "value": "{TAG_ID}" }
    ]
  }],
  "limit": 1
}
```

Repetir para:

| Tag ID | Etiqueta |
|--------|----------|
| `25397313` | PRIORITARIO |
| `25397323` | ALTO POTENCIAL |
| `25397324` | POTENCIAL |
| `25397333` | NURTURING |
| `25397556` | DESATENDIDO |

---

## Resumen del motor de datos

| Query | Motor | Datos que devuelve | Para secciones |
|-------|-------|--------------------|----------------|
| Q1 | `query_crm_data` (SQL) | etapa × deals × valor | §1, §2 |
| Q2 | `query_crm_data` (SQL) | owner × etapa × deals × valor | §3, scorecard |
| Q3 | `query_crm_data` (SQL) | ganados/perdidos hoy | §1 |
| Q4 | `query_crm_data` (SQL) | main_sku únicos | §5 |
| **Q5-A** | `query_crm_data` (SQL, FROM CALL) | llamadas × owner × programa | §3 (gestión A) |
| **Q5-B** | `query_crm_data` (SQL, FROM MEETING_EVENT) | reuniones × owner × programa | §3 (gestión A) |
| **Q5-C** | `query_crm_data` (SQL, FROM DEAL) | movimientos × etapa-destino × owner | §3 (gestión P) |
| Q6 | `search_crm_objects` (REST) | desatendidos × owner (1 call/owner) | §1, §3, §4 |
| Q7 | `search_crm_objects` (REST) | conteo × etiqueta (5 calls) | §1 |

**Regla de decisión:**
- Datos numéricos agrupables (etapas, owners, montos, fechas) → `query_crm_data` SQL con `GROUP BY` + fechas `'YYYY-MM-DD'` + tabla `DEAL`
- Datos con tags / multi-valor (`hs_tag_ids`) → `search_crm_objects` REST con `CONTAINS_TOKEN` + leer `total`

---

## Recetas individuales (para drill-down y consultas)

### Detalle de un deal

```
GET /crm/v3/objects/deals/{DEAL_ID}
properties: dealname, dealstage, amount, pipeline, hubspot_owner_id, main_sku,
            hs_lastmodifieddate, notes_last_contacted, notes_next_activity_date,
            createdate, closedate, hs_tag_ids, hs_v2_date_entered_current_stage,
            resultado_del_intento_de_contacto, resultado_del_contacto_logrado,
            califica_para_el_programa, resultado_de_calificaci_n,
            estado_de_la_agenda, cambio_de_agenda,
            resultado_de_reuni_n_completada, estado_de_la_negociaci_n
```

> ⚠️ HVM (`hvm_tier`, `hvm_score_total`, `hvm_confidence`, `hvm_scored_at`) vive en el **CONTACTO** asociado, NO en el deal. Ver receta abajo.

### HVM desde contacto asociado al deal

Paso 1 — Obtener contacto:
```
GET /crm/v3/objects/deals/{DEAL_ID}/associations/contacts
```

Paso 2 — Obtener HVM del contacto:
```
GET /crm/v3/objects/contacts/{CONTACT_ID}
properties: firstname, lastname, email, company,
            hvm_tier, hvm_score_total, hvm_confidence, hvm_scored_at
```

> ⚠️ El scorer automático tiene **cobertura limitada**. Muchos contactos NO tienen HVM poblado. Si `hvm_scored_at` está vacío → no ha sido evaluado. No asumir tier por default.

### Buscar contacto directo + HVM

```
POST /crm/v3/objects/contacts/search
filterGroups: email = '{EMAIL}'
properties: firstname, lastname, email, company,
            hvm_tier, hvm_score_total, hvm_confidence, hvm_scored_at
```

### Actualizar un deal

```
PATCH /crm/v3/objects/deals/{DEAL_ID}
{ "properties": { "dealstage": "{STAGE_ID}" } }
```

> ⚠️ SIEMPRE confirmar con el usuario antes de ejecutar.

### Avances de etapa hoy (drill-down opcional)

```
POST /crm/v3/objects/deals/search
filterGroups: pipeline = {PID} AND hs_lastmodifieddate >= {INICIO_DIA}
properties: dealname, dealstage, hubspot_owner_id, amount
propertiesWithHistory: dealstage
limit: 50
```

> Límite = 50 con `propertiesWithHistory`. Solo usar como drill-down bajo demanda, no como parte del reporte principal.

### Meetings del día (drill-down — Aprovechamiento)

```
POST /crm/v3/objects/meetings/search
filterGroups: hs_meeting_start_time >= {INICIO_DIA} AND <= {FIN_DIA}
properties: hs_meeting_title, hs_meeting_start_time, hs_meeting_end_time,
            hs_meeting_outcome, hubspot_owner_id
limit: 100
```

Cálculo:
```
Horas reunión = Σ(end - start) por owner
Horas libres = 8h - horas reunión
Gest/hora = gestiones_hoy ÷ horas_libres
Flag: ≥2.0 = ✅ | 1.0-2.0 = 🟡 | <1.0 = 🔴
```

### Buscar leads

```
POST /crm/v3/objects/leads/search
filterGroups: hs_pipeline = '905179198'
properties: firstname, lastname, email, empresa, cargo, hs_pipeline_stage,
            registrado_en_webinar, confirmo_asistencia_a_webinar_,
            asistio_a_webinar, hubspot_owner_id
limit: 100
```

### Listar owners

```
GET /crm/v3/owners/?limit=100
```

### Obtener pipelines

```
GET /crm/v3/pipelines/deals
GET /crm/v3/pipelines/leads
```

---

## Notas técnicas

- **Zona horaria:** America/Bogota (UTC-5). Inicio del día = 00:00 local = 05:00 UTC.
- **Fechas en SQL (`query_crm_data`):** Usar strings `'YYYY-MM-DD'` con `BETWEEN`. Tabla en mayúscula singular: `FROM DEAL`.
- **Timestamps en REST (`search_crm_objects`):** Usar milisegundos epoch UTC.
- **Rate limits:** 100 requests / 10 seg.
- **Operadores REST:** EQ, NEQ, LT, LTE, GT, GTE, HAS_PROPERTY, NOT_HAS_PROPERTY, CONTAINS_TOKEN, IN, NOT_IN.
- **Tags:** `hs_tag_ids` es multi-valor → solo filtrable con `CONTAINS_TOKEN` vía REST, no con SQL.
- **Stage IDs:** Siempre usar ID numérico, nunca el nombre.
- **GROUP BY:** El motor de reporting soporta **máximo 2 dimensiones**. Si necesitas pipeline + owner + etapa, fija el pipeline en el WHERE (`AND pipeline = '...'`) y agrupa por las otras dos, o deriva el pipeline del Stage ID.
- **Objetos de actividad (V2.2):** `CALL` y `MEETING_EVENT` se cruzan bien con `DEAL.pipeline`. `EMAIL` NO se cruza con DEAL (falla el motor) → consultarlo solo por owner. `NOTE` y `TASK` NO son gestión (notas por automatización; tareas por creación masiva).
- **`hs_timestamp`** es la fecha del engagement (cuándo ocurrió). Usar `BETWEEN '{YYYY-MM-DD}' AND '{YYYY-MM-DD}'` (mismo día inicio y fin).
- **`notes_last_contacted` DEPRECADA** como métrica de gestión desde V2.2.
- **DESATENDIDO:** Tag `25397556` es la fuente autoritativa. No heurísticas.
- **HVM:** Vive en CONTACTO, no en deal. Requiere association lookup.
- **Velocidad en etapa:** Usar `hs_v2_date_entered_current_stage` del deal (no `propertiesWithHistory`).
