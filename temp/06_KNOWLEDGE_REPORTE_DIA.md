---
name: Reporte Día — Especificación V2.2
description: Especificación del reporte día V2.2. Sección 0 = dashboard HTML (show_widget) con tarjetas, funnel chart, scorecard por comercial, alertas y botones sendPrompt. Pipeline gestionable vs intake. Motor SQL (query_crm_data). Desatendidos por tag oficial. Velocidad con hs_v2_date_entered_current_stage. GESTIÓN V2.2 = actividad real (A: llamada/reunión) + avance de protocolo (P), sin notas/tareas/intake/auto-pago.
---

# Comando: Reporte Día — Especificación V2.2

## Activación

`reporte día [programa]`, `reporte del día [programa]`, `/reporte_dia [programa]`

## Flujo

1. Usuario indica programa → genera reporte completo con dashboard
2. Al final muestra cohortes → filtro por `main_sku`
3. Drill-down conversacional (comercial, aprovechamiento, etc.)

---

## Conceptos clave

### Pipeline gestionable vs intake

| Zona | Etapas incluidas | Rol |
|------|-----------------|-----|
| **Intake / backlog** | Potencial, Registrado | Masa sin gestionar. Solo se reporta como referencia. |
| **Pipeline gestionable** | En gestión → CV / Reservado | Métrica principal. Todas las alertas, velocidad y métricas aplican aquí. |
| **Cerrados** | Ganado Pago Parcial, Ganado Pagado Completo, Cierre perdido | Solo conteo del día. |

> ⚠️ Velocidad, estancados y desatendidos se calculan SOLO sobre pipeline gestionable.

### GESTIÓN del día (V2.2) — actividad real (A) + avance de protocolo (P)

La gestión NO se mide con `notes_last_contacted` (deprecada — la mueven notas y bots). Un deal está gestionado si:
- **(A) Actividad real**: llamada (`CALL`) o reunión (`MEETING_EVENT`) del comercial ese día. NO notas, NO tareas. → Q5-A + Q5-B.
- **(P) Avance de protocolo**: entró ese día a una etapa de trabajo/decisión (Contactado → Cierre perdido), por llenar una propiedad condicional que disparó un WF. NO cuenta entrar a Potencial/Registrado/En gestión ni a Ganado Pagado Completo. → Q5-C + clasificación 3.5 de `02`.

Reportar **A y P en columnas separadas** (no sumarlas como deals únicos). Definición completa en `01_SYSTEM_PROMPT.md`.

### Desatendidos

**Fuente autoritativa:** tag `25397556` en `hs_tag_ids`. NO usar heurística de `notes_last_contacted`.

### Velocidad por etapa

Usar `hs_v2_date_entered_current_stage` (fecha en que el deal entró a su etapa actual).
```
Días en etapa = (hoy - hs_v2_date_entered_current_stage)
Promedio por etapa = AVG de los días de todos los deals en esa etapa
Estancado = deal con días > 2× promedio de su etapa
```
NO usar `propertiesWithHistory` para esto — es más lento y tiene límite de 50 registros.

---

## Estructura del reporte (Secciones 0-5)

### SECCIÓN 0 — DASHBOARD VISUAL (HTML con show_widget)

Renderizar un dashboard HTML interactivo con `show_widget`. El texto narrativo (resumen, recomendaciones) va FUERA del widget.

#### Fila 1 — 6 tarjetas métricas

| Tarjeta | Fuente | Color |
|---------|--------|-------|
| Pipeline gestionable US$ | Q1: SUM(amount) etapas gestionables | Azul |
| Actividad real hoy (A) | Q5-A + Q5-B: llamadas + reuniones (equipo activo) | Verde |
| Avances protocolo hoy (P) | Q5-C: deals a etapas de trabajo/decisión | Verde |
| Ganados hoy | Q3: deals en etapa won con closedate hoy | Verde |
| Perdidos hoy | Q3: deals en etapa lost con closedate hoy | Rojo |
| Backlog (Potencial + Registrado) | Q1: deals en etapas intake | Gris |

Ejemplo HTML de una tarjeta:
```html
<div style="background:#e8f4fd; border-radius:8px; padding:16px; text-align:center;">
  <div style="font-size:24px; font-weight:bold; color:#1a73e8;">US$2.3M</div>
  <div style="font-size:12px; color:#666;">Pipeline gestionable</div>
</div>
```

Usar `display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;` para la grilla de 6 tarjetas.

#### Fila 2 — Funnel por etapa (bar chart horizontal)

- Barras horizontales por etapa del pipeline gestionable (EXCLUYENDO Potencial y Registrado)
- Cada barra muestra: nombre etapa | barra proporcional | deals (valor)
- Usar `width: {porcentaje}%` con CSS para las barras. No depender de librerías externas.

Ejemplo:
```html
<div style="display:flex; align-items:center; margin:4px 0;">
  <div style="width:120px; font-size:12px;">En gestión</div>
  <div style="background:#4285f4; height:24px; width:65%; border-radius:4px;"></div>
  <div style="margin-left:8px; font-size:12px;">20 ($480K)</div>
</div>
```

#### Fila 3 — 2 charts horizontales por comercial (solo equipo activo)

**Chart A: Gestión real por comercial — A (llamadas+reuniones) y P (avances protocolo)** (fuente: Q5-A + Q5-B + Q5-C)
**Chart B: CV / Reservado por comercial** (fuente: Q2 filtrado)

Barras horizontales, una por comercial. Misma técnica CSS que el funnel.

#### Fila 4 — Alertas con acción concreta

- Cards rojo: DESATENDIDOS — `"[N] deals con tag DESATENDIDO. Owner: [nombre]. Acción: contactar hoy o mover a Cierre perdido."`
- Cards ámbar: Estancados — `"[N] deals >2× promedio en etapa. Revisar bloqueo."`

```html
<div style="background:#fdecea; border-left:4px solid #d93025; padding:12px; border-radius:4px; margin:8px 0;">
  <strong>🔴 3 deals DESATENDIDOS</strong> — Owner: Vicky. Contactar hoy o cerrar.
</div>
```

#### Fila 5 — Botones sendPrompt

3 botones que disparan análisis adicionales:

```html
<button onclick="sendPrompt('Muéstrame el aprovechamiento del día: reuniones vs gestiones por comercial')">
  📊 Aprovechamiento del día
</button>
<button onclick="sendPrompt('Drill-down de deals en Compromiso Verbal y Reservado')">
  🔍 Drill-down CV
</button>
<button onclick="sendPrompt('Muéstrame los cohortes disponibles para filtrar')">
  🎯 Filtrar por cohorte
</button>
```

> **REGLA:** Todo el texto narrativo va FUERA del widget (antes o después). Dentro del widget solo métricas, charts y botones.

---

### SECCIÓN 1 — RESUMEN EJECUTIVO (texto, fuera del widget)

```
📊 REPORTE DÍA — [Programa] — [Fecha]

💰 PIPELINE GESTIONABLE (En gestión → CV/Reservado):
   [N] deals | US$[X] valor

📥 INTAKE / BACKLOG:
   Potencial: [N] | Registrado: [N] | Total: [N] deals

📈 GESTIÓN HOY (V2.2):
   Actividad real (A): [N] llamadas + [N] reuniones
   Avances de protocolo (P): [N] deals a etapas de trabajo/decisión
   Ganados: [N] (US$[X]) | Perdidos: [N]

🏷️ ETIQUETAS:
   PRIORITARIO: [N] | ALTO POTENCIAL: [N] | POTENCIAL: [N] | NURTURING: [N] | DESATENDIDO: [N]

🚨 ALERTAS:
   🔴 [N] desatendidos (tag) | 🟡 [N] estancados | ⚠️ [N] sin owner
```

**Cómo calcular:**
- **Pipeline gestionable:** Q1 — sumar deals y valor de etapas entre En gestión y CV/Reservado.
- **Intake:** Q1 — deals en Potencial + Registrado.
- **Actividad real (A):** Q5-A + Q5-B — llamadas + reuniones del día por owner (excluir filas `Unassigned`). NO notas ni tareas.
- **Avances de protocolo (P):** Q5-C — deals que entraron hoy a etapas ✅ (clasificación 3.5 de `02`). Excluir intake (Potencial/Registrado/En gestión) y Ganado Pagado Completo.
- **Ganados/Perdidos:** Q3 — deals con closedate hoy en etapas won/lost.
- **Etiquetas:** Q7 — 5 búsquedas CONTAINS_TOKEN.
- **Desatendidos:** Q6 — deals con tag `25397556`. Fuente autoritativa.
- **Estancados:** Q1 + detalle — deals cuyo `hs_v2_date_entered_current_stage` implica >2× el promedio de su etapa.
- **Sin owner:** Q2 — deals donde `hubspot_owner_id` es vacío o nulo.

---

### SECCIÓN 2 — SALUD DEL PIPELINE (por etapa, solo gestionable)

```
SALUD DEL PIPELINE GESTIONABLE
┌─────────────────────┬───────┬────────┬─────────┬──────┬──────┬──────┐
│ Etapa               │ Deals │ Valor  │Vel.prom │ <24h │ 1-3d │ >3d  │
├─────────────────────┼───────┼────────┼─────────┼──────┼──────┼──────┤
│ En gestión          │   20  │ $480K  │  1.8d   │  12  │   5  │   3  │
│ Contactado          │   13  │ $312K  │  3.2d   │   6  │   4  │   3  │
│ Calificado          │    9  │ $216K  │  2.5d   │   4  │   3  │   2  │
│ Reunión agendada    │    5  │ $120K  │  1.2d   │   3  │   2  │   0  │
│ Reunión ocurrida    │    2  │  $48K  │  4.1d   │   0  │   1  │   1  │
│ En negociación      │    6  │ $144K  │  3.8d   │   2  │   2  │   2  │
│ CV / Reservado      │    2  │  $48K  │  2.0d   │   1  │   1  │   0  │
├─────────────────────┼───────┼────────┼─────────┼──────┼──────┼──────┤
│ TOTAL GESTIONABLE   │   57  │ $1.4M  │         │  28  │  18  │  11  │
└─────────────────────┴───────┴────────┴─────────┴──────┴──────┴──────┘

INTAKE (referencia):
  Potencial: [N] ($[X]) | Registrado: [N] ($[X])

⚠️ Estancados (>2× promedio en etapa):
  • [Deal] — [Etapa] hace [X]d (prom: [Y]d) — Owner: [nombre]
```

**Columnas:**
- **Vel.prom:** `AVG(hoy - hs_v2_date_entered_current_stage)` por etapa.
- **<24h / 1-3d / >3d:** Cantidad de deals según cuándo fue su `notes_last_contacted`.

**Velocidad por etapa (ingresos):** Usar `hs_v2_date_entered_current_stage` para calcular cuántos días lleva cada deal en su etapa actual. Es más preciso y rápido que `propertiesWithHistory`.

---

### SECCIÓN 3 — SCORECARD + GESTIÓN POR COMERCIAL

#### 3A — SCORECARD (vista rápida)

```
SCORECARD POR COMERCIAL
┌───────────────┬──────┬──────┬─────────┬────────┬──────────┬──────┐
│ Comercial     │ A    │ P    │Pipeline │ Valor  │🔴 Desat. │ Flag │
│               │act.  │prot. │ gest.   │ gest.  │          │      │
├───────────────┼──────┼──────┼─────────┼────────┼──────────┼──────┤
│ JJ            │  12  │   8  │    35   │ $840K  │    2     │  ✅  │
│ Vicky         │   2  │   3  │    22   │ $528K  │    4     │  🔴  │
│ Dana          │   8  │   5  │    29   │ $696K  │    1     │  🟡  │
├───────────────┼──────┼──────┼─────────┼────────┼──────────┼──────┤
│ EQUIPO ACTIVO │  22  │  16  │    86   │ $2.1M  │    7     │      │
├───────────────┼──────┼──────┼─────────┼────────┼──────────┼──────┤
│ Cuentas-pool  │   0  │   0  │  8500   │ $204M  │   320    │(pool)│
└───────────────┴──────┴──────┴─────────┴────────┴──────────┴──────┘

A = actividad real (llamadas+reuniones, Q5-A+Q5-B) · P = avances de protocolo (Q5-C, etapas ✅)
Flag: ✅ A+P ≥10 | 🟡 5-9 | 🔴 A=0 y P=0 (advertir punto ciego antes de afirmar) o desatendidos >10% de su pipeline
```

**Cuentas-pool:** Owner IDs `90090091, 89422210, 90185405, 90154136, 90056486, 90154155`. Solo fila agregada, NO drill-down.

**Fuentes:** Q2 SQL (pipeline por owner), **Q5-A + Q5-B** SQL (actividad real A: llamadas+reuniones por owner), **Q5-C** SQL (avances de protocolo P por owner, clasificando etapas con sección 3.5 de `02`), Q6 REST (desatendidos por owner — `search_crm_objects` con `CONTAINS_TOKEN` × N owners).

#### 3B — TABLA DETALLADA (solo equipo activo)

```
GESTIÓN POR COMERCIAL
┌─────────────────────┬───────┬───────┬───────┬───────┐
│                     │  JJ   │ Vicky │ Dana  │ TOTAL │
├─────────────────────┼───────┼───────┼───────┼───────┤
│ ACTIVIDAD REAL (A)                                  │
│ Llamadas            │    9  │    2  │    6  │   17  │
│ Reuniones           │    3  │    0  │    2  │    5  │
│ Subtotal A          │   12  │    2  │    8  │   22  │
├─────────────────────┼───────┼───────┼───────┼───────┤
│ AVANCES PROTOCOLO (P) — por etapa de destino ✅     │
│  · Contactado       │    3  │    1  │    2  │    6  │
│  · Calificado       │    2  │    1  │    1  │    4  │
│  · Agendado         │    2  │    0  │    1  │    3  │
│  · Atendido/CV/Neg. │    1  │    1  │    1  │    3  │
│ Subtotal P          │    8  │    3  │    5  │   16  │
├─────────────────────┼───────┼───────┼───────┼───────┤
│ PIPELINE GESTIONABLE                                │
│ Total deals         │   35  │   22  │   29  │   86  │
│ Valor total         │ $840K │ $528K │ $696K │ $2.1M │
├─────────────────────┼───────┼───────┼───────┼───────┤
│ 🔴 ALERTAS                                          │
│ Desatendidos (tag)  │    2  │    4  │    1  │    7  │
│ Sin gestión (A=0,P=0)│      │       │       │       │
└─────────────────────┴───────┴───────┴───────┴───────┘
```

> Emails (referencia, no atribuibles a programa): listar volumen por owner debajo de la tabla.
> Tareas: NO incluir como gestión (creación masiva por bot). Mencionar solo si el usuario lo pide, marcado como ruido.

---

### SECCIÓN 4 — DEALS CRÍTICOS

```
🚨 DEALS CRÍTICOS

TOP 5 EN RIESGO (mayor valor + tag DESATENDIDO):
  1. [Deal] — US$24K — Calificado hace 12d — DESATENDIDO — Owner: JJ
  2. [Deal] — US$24K — En negociación hace 8d — DESATENDIDO — Owner: Vicky

🏷️ PRIORITARIO SIN ACCIÓN RECIENTE (tag 25397313 + notes_last_contacted > 2d):
  • [Deal] — PRIORITARIO — Último contacto hace 3d — Owner: Dana

⚠️ DEALS SIN OWNER:
  • [Deal] — US$24K — Contactado — Sin asignar
```

**Desatendidos** = deals con tag `25397556`. **PRIORITARIO** = tag `25397313`.

---

### SECCIÓN 5 — COHORTES DISPONIBLES

```
🎯 Cohortes disponibles para [Programa]:
  [1] multipliers_junio_2026 (136 deals)
  [2] multipliers_marzo_2026 (89 deals)
  [3] Todos (225 deals) ← actualmente mostrando

¿Filtrar por cohorte? Escribe el número o nombre.
```

Fuente: Q4 (main_sku × count).

---

## Drill-downs opcionales (vía botón sendPrompt o pregunta del usuario)

### Aprovechamiento del día (reuniones vs gestiones)

Requiere consulta de meetings del día (ver receta en `05`).

```
⏰ APROVECHAMIENTO DEL DÍA
┌───────────────────┬────────┬────────┬────────┬────────┐
│                   │   JJ   │ Vicky  │  Dana  │ TOTAL  │
├───────────────────┼────────┼────────┼────────┼────────┤
│ Reuniones hoy     │    3   │    1   │    2   │    6   │
│ Horas en reunión  │  2.5h  │  1.0h  │  1.5h  │  5.0h  │
│ Horas libres est. │  5.5h  │  7.0h  │  6.5h  │ 19.0h  │
│ Gestiones hechas  │   12   │    5   │    8   │   25   │
│ Gest/hora libre   │  2.2   │  0.7   │  1.2   │  1.3   │
│ Flag              │   ✅   │   🔴   │   🟡   │        │
└───────────────────┴────────┴────────┴────────┴────────┘
```

Limitación: solo cuenta reuniones en HubSpot.

### Avances de etapa hoy

Requiere `propertiesWithHistory` (límite 50/page). Mostrar qué deals cambiaron de etapa.

### Drill-down por comercial

Detalle de todos los deals de un comercial específico.

---

## Orden de ejecución de queries

1. `GET /crm/v3/owners` → mapa IDs → nombres (necesario para Q6)
2. **Q1** → `query_crm_data` SQL → etapa × deals × valor
3. **Q2** → `query_crm_data` SQL → owner × etapa × deals × valor
4. **Q3** → `query_crm_data` SQL → ganados/perdidos hoy
5. **Q5-A** → `query_crm_data` SQL (FROM CALL) → llamadas × owner × programa
6. **Q5-B** → `query_crm_data` SQL (FROM MEETING_EVENT) → reuniones × owner × programa
7. **Q5-C** → `query_crm_data` SQL (FROM DEAL) → movimientos × etapa-destino × owner (clasificar con 3.5 de `02`)
8. **Q6** → `search_crm_objects` REST × N owners → desatendidos × owner
9. **Q7** → `search_crm_objects` REST × 5 tags → conteo × etiqueta
10. **Q4** → `query_crm_data` SQL → cohortes

Queries 2-10 son independientes entre sí → ejecutar en paralelo.

> **Regla de motor:**
> - Q1-Q4, Q5-A/B/C → SQL (`query_crm_data`) con fechas `'YYYY-MM-DD'`. Tablas: `DEAL`, `CALL`, `MEETING_EVENT`. Máx. 2 dimensiones en GROUP BY.
> - Q6, Q7 → REST (`search_crm_objects`) con `CONTAINS_TOKEN` + leer `total` (tags no filtran en SQL)
> - Gestión = A (Q5-A + Q5-B, sin notas/tareas) + P (Q5-C, solo etapas ✅). NO usar `notes_last_contacted`.

Luego renderizar: §0 (dashboard HTML) → §1 → §2 → §3 → §4 → §5.

## Zona horaria

America/Bogota (UTC-5). Inicio del día = 00:00:00 local = 05:00:00 UTC.
