---
name: Pipeline de Deals — 30X
description: Estructura completa de los 16 pipelines de deals en HubSpot. Incluye IDs de etapas, mapeo de equivalencias entre programas, propiedades condicionales por etapa, y definición de deal DESATENDIDO.
---

# Pipeline de Deals — Todos los Programas 30X V2.2

> Última actualización: 11 junio 2026

---

## 1. Tipos de Pipeline

Existen 2 variantes de pipeline en 30X:

### Variante A — Pipeline Estándar (14 programas)
Etapas: Potencial → Registrado → [En gestión] → Contactado → Calificado → Agendado → Atendido → Compromiso Verbal → Ganado Pago Parcial → Ganado Pagado Completo → Cierre perdido

> Nota: Algunos pipelines tienen la etapa "En gestión" entre Registrado y Contactado, otros no.

### Variante B — Pipeline Multipliers (1 programa)
Etapas: Potencial → En gestión → Contactado → Calificado → Reunión agendada → Reunión ocurrida → En negociación → Reservado → Ganado Pago Parcial → Ganado Pagado Completo → Cierre perdido

---

## 2. IDs de Pipelines y Etapas

### Multipliers (Variante B) — ID: `897337694`

| # | Etapa | Stage ID | Prob |
|---|-------|----------|------|
| 0 | Potencial | `1355931136` | 10% |
| 1 | En gestión | `1368995987` | 20% |
| 2 | Contactado | `1355931138` | 30% |
| 3 | Calificado | `1368995988` | 40% |
| 4 | Reunión agendada | `1368995989` | 50% |
| 5 | Reunión ocurrida | `1369738655` | 60% |
| 6 | En negociación | `1368995990` | 70% |
| 7 | Reservado | `1360866389` | 80% |
| 8 | Ganado Pago Parcial | `1355931143` | WON |
| 9 | Ganado Pagado Completo | `1355931144` | WON |
| 10 | Cierre perdido | `1355931145` | LOST |

### AI for Executives — ID: `887379062`

| # | Etapa | Stage ID |
|---|-------|----------|
| 0 | Potencial | `1334246304` |
| 1 | Registrado | `1334246305` |
| 2 | En gestión | `1374066295` |
| 3 | Contactado | `1334246955` |
| 4 | Calificado | `1334246306` |
| 5 | Agendado | `1334261546` |
| 6 | Atendido | `1334261547` |
| 7 | Compromiso Verbal | `1334261548` |
| 8 | Ganado Pago Parcial | `1334246307` |
| 9 | Ganado Pagado Completo | `1334246308` |
| 10 | Cierre perdido | `1334261549` |

### Sales Machine — ID: `887379061`

| # | Etapa | Stage ID |
|---|-------|----------|
| 0 | Potencial | `1334246299` |
| 1 | Registrado | `1334246300` |
| 2 | En gestión | `1374066294` |
| 3 | Contactado | `1334246939` |
| 4 | Calificado | `1334246301` |
| 5 | Agendado | `1334246940` |
| 6 | Atendido | `1334246941` |
| 7 | Compromiso Verbal | `1334246942` |
| 8 | Ganado Pago Parcial | `1334246302` |
| 9 | Ganado Pagado Completo | `1334246303` |
| 10 | Cierre perdido | `1334246943` |

### AI Sales — ID: `887379060`

| # | Etapa | Stage ID |
|---|-------|----------|
| 0 | Potencial | `1334246294` |
| 1 | Registrado | `1334246295` |
| 2 | En gestión | `1374065562` |
| 3 | Contactado | `1334246936` |
| 4 | Calificado | `1334246296` |
| 5 | Agendado | `1334261535` |
| 6 | Atendido | `1334246937` |
| 7 | Compromiso Verbal | `1334261536` |
| 8 | Ganado Pago Parcial | `1334246297` |
| 9 | Ganado Pagado Completo | `1334246298` |
| 10 | Cierre perdido | `1334246938` |

### Hardcore AI — ID: `887379064`

| # | Etapa | Stage ID |
|---|-------|----------|
| 0 | Potencial | `1334246314` |
| 1 | Registrado | `1334246315` |
| 2 | En gestión | `1374066297` |
| 3 | Contactado | `1334246961` |
| 4 | Calificado | `1334246316` |
| 5 | Agendado | `1334246962` |
| 6 | Atendido | `1334246963` |
| 7 | Compromiso Verbal | `1334261560` |
| 8 | Ganado Pago Parcial | `1334246317` |
| 9 | Ganado Pagado Completo | `1334246318` |
| 10 | Cierre perdido | `1334261561` |

### 30X Executive Program — ID: `887370120`

| # | Etapa | Stage ID |
|---|-------|----------|
| 0 | Potencial | `1334260995` |
| 1 | Registrado | `1334260996` |
| 2 | En gestión | `1371317920` |
| 3 | Contactado | `1334246933` |
| 4 | Calificado | `1334260997` |
| 5 | Agendado | `1334261533` |
| 6 | Atendido | `1334261534` |
| 7 | Compromiso Verbal | `1334246934` |
| 8 | Ganado Pago Parcial | `1334260998` |
| 9 | Ganado Pagado Completo | `1334260999` |
| 10 | Cierre perdido | `1334246935` |

### Everybody AI — ID: `887370121`

| # | Etapa | Stage ID |
|---|-------|----------|
| 0 | Potencial | `1334261000` |
| 1 | Registrado | `1334261001` |
| 2 | Contactado | `1334246944` |
| 3 | Calificado | `1334261002` |
| 4 | Agendado | `1334246945` |
| 5 | Atendido | `1334261537` |
| 6 | Compromiso Verbal | `1334261543` |
| 7 | Ganado Pago Parcial | `1334261003` |
| 8 | Ganado Pagado Completo | `1334261004` |
| 9 | Cierre perdido | `1334246951` |

### High Ticket Sales — ID: `887370122`

| # | Etapa | Stage ID |
|---|-------|----------|
| 0 | Potencial | `1334261005` |
| 1 | Registrado | `1334261006` |
| 2 | Contactado | `1334246952` |
| 3 | Calificado | `1334261007` |
| 4 | Agendado | `1334246953` |
| 5 | Atendido | `1334261544` |
| 6 | Compromiso Verbal | `1334246954` |
| 7 | Ganado Pago Parcial | `1334261008` |
| 8 | Ganado Pagado Completo | `1334261009` |
| 9 | Cierre perdido | `1334261545` |

### Negociacion — ID: `887370124`

| # | Etapa | Stage ID |
|---|-------|----------|
| 0 | Potencial | `1334261015` |
| 1 | Registrado | `1334261016` |
| 2 | Contactado | `1334246957` |
| 3 | Calificado | `1334261017` |
| 4 | Agendado | `1334261554` |
| 5 | Atendido | `1334246958` |
| 6 | Compromiso Verbal | `1334261555` |
| 7 | Ganado Pago Parcial | `1334261018` |
| 8 | Ganado Pagado Completo | `1334261019` |
| 9 | Cierre perdido | `1334261556` |

### Operaciones con AI — ID: `887379063`

| # | Etapa | Stage ID |
|---|-------|----------|
| 0 | Potencial | `1334246309` |
| 1 | Registrado | `1334246310` |
| 2 | Contactado | `1334261557` |
| 3 | Calificado | `1334246311` |
| 4 | Agendado | `1334246959` |
| 5 | Atendido | `1334261558` |
| 6 | Compromiso Verbal | `1334261559` |
| 7 | Ganado Pago Parcial | `1334246312` |
| 8 | Ganado Pagado Completo | `1334246313` |
| 9 | Cierre perdido | `1334246960` |

### AI Second Brain — ID: `904247681`

| # | Etapa | Stage ID |
|---|-------|----------|
| 0 | Potencial | `1368121616` |
| 1 | Registrado | `1368121617` |
| 2 | En gestión | `1374066296` |
| 3 | Contactado | `1368121618` |
| 4 | Calificado | `1368121619` |
| 5 | Agendado | `1368121620` |
| 6 | Atendido | `1368121621` |
| 7 | Compromiso Verbal | `1368121622` |
| 8 | Ganado Pago Parcial | `1368121623` |
| 9 | Ganado Pagado Completo | `1368121624` |
| 10 | Cierre perdido | `1368121625` |

### Xtreme Growth AI — ID: `902104178`

| # | Etapa | Stage ID |
|---|-------|----------|
| 0 | Potencial | `1364140612` |
| 1 | Registrado | `1364140613` |
| 2 | En gestión | `1374066298` |
| 3 | Contactado | `1364140614` |
| 4 | Calificado | `1364140615` |
| 5 | Agendado | `1364140616` |
| 6 | Atendido | `1364140617` |
| 7 | Compromiso Verbal | `1364140618` |
| 8 | Ganado Pago Parcial | `1364140619` |
| 9 | Ganado Pagado Completo | `1364140620` |
| 10 | Cierre perdido | `1364140621` |

### Next Fellowship — ID: `892149608`

| # | Etapa | Stage ID |
|---|-------|----------|
| 0 | Potencial | `1344514958` |
| 1 | Registrado | `1344514959` |
| 2 | En gestión | `1374065563` |
| 3 | Contactado | `1344568230` |
| 4 | Calificado | `1344514960` |
| 5 | Agendado | `1344568231` |
| 6 | Atendido | `1344568232` |
| 7 | Compromiso Verbal | `1344568233` |
| 8 | Ganado Pago Parcial | `1344514961` |
| 9 | Ganado Pagado Completo | `1344514962` |
| 10 | Cierre perdido | `1344568234` |

### Free Sales Training — ID: `894939988`

| # | Etapa | Stage ID |
|---|-------|----------|
| 0 | Potencial | `1350924635` |
| 1 | Registrado | `1350924636` |
| 2 | Contactado | `1350924637` |
| 3 | Calificado | `1350924638` |
| 4 | Agendado | `1350924639` |
| 5 | Atendido | `1350924640` |
| 6 | Compromiso Verbal | `1350924641` |
| 7 | Ganado Pago Parcial | `1350924642` |
| 8 | Ganado Pagado Completo | `1350924643` |
| 9 | Cierre perdido | `1350924644` |

### Ventas con LinkedIn — ID: `906259304`

| # | Etapa | Stage ID |
|---|-------|----------|
| 0 | Potencial | `1372359680` |
| 1 | Registrado | `1372359681` |
| 2 | En gestión | `1372359682` |
| 3 | Contactado | `1372359683` |
| 4 | Calificado | `1372359684` |
| 5 | Agendado | `1372359685` |
| 6 | Atendido | `1372359686` |
| 7 | Compromiso Verbal | `1372359687` |
| 8 | Ganado Pago Parcial | `1372359688` |
| 9 | Ganado Pagado Completo | `1372359689` |
| 10 | Cierre perdido | `1372359690` |

---

## 3. Mapeo de Etapas Equivalentes

Para generar reportes homogéneos entre programas, usa este mapeo:

| Concepto | Variante A (estándar) | Variante B (Multipliers) |
|----------|----------------------|--------------------------|
| Lead crudo | Potencial | Potencial |
| Registrado | Registrado | *(no aplica)* |
| Gestión iniciada | En gestión | En gestión |
| Contacto logrado | Contactado | Contactado |
| Califica | Calificado | Calificado |
| Reunión agendada | Agendado | Reunión agendada |
| Reunión completada | Atendido | Reunión ocurrida |
| Compromiso post-reunión | Compromiso Verbal | En negociación |
| Reserva | *(no aplica)* | Reservado |
| Ganado parcial | Ganado Pago Parcial | Ganado Pago Parcial |
| Ganado total | Ganado Pagado Completo | Ganado Pagado Completo |
| Perdido | Cierre perdido | Cierre perdido |

---

## 3.5 Clasificación de etapas para GESTIÓN (V2.2)

Para medir gestión real (ver definición en `01_SYSTEM_PROMPT.md`), cada etapa de destino de un movimiento se clasifica así:

| Clase | Etapas | ¿Es gestión (P)? |
|-------|--------|------------------|
| **Trabajo / decisión** | Contactado, Calificado, Agendado / Reunión agendada, Atendido / Reunión ocurrida, Compromiso Verbal / En negociación, Reservado | ✅ SÍ — exige llenar propiedad condicional → WF mueve el deal |
| **Venta** | Ganado Pago Parcial | ✅ SÍ — outcome real (reserva / primer pago) |
| **Descarte** | Cierre perdido | ✅ SÍ — decisión de gestión (se llena `…Descartar`) |
| **Intake / asignación** | Potencial, Registrado, En gestión | ❌ NO — masa sin trabajar o toma de lead |
| **Auto-pago** | Ganado Pagado Completo | ❌ NO — WF automático al llegar el saldo a cero |

> **Regla:** Para contar avances de protocolo (P) de un comercial, cuenta solo los deals que entraron ese día a etapas ✅. Cruza el `dealstage` (Stage ID) devuelto por el motor con las tablas de la sección 2 para identificar la etapa y su clase.

> **Por qué excluir "En gestión":** entrar a "En gestión" es asignación / toma de lead (a menudo en lote), no trabajo del deal. La gestión empieza al SALIR de "En gestión" hacia "Contactado" (se llena `resultado_del_intento_de_contacto` = "Contacto logrado").

---

| Propiedad | Uso |
|-----------|-----|
| `dealname` | Nombre del deal |
| `dealstage` | ID de etapa actual |
| `pipeline` | ID del pipeline |
| `amount` | Valor en USD |
| `hubspot_owner_id` | Comercial asignado |
| `main_sku` | Cohorte/producto (para filtrar por lanzamiento) |
| `hs_tag_ids` | Etiquetas (IDs separados por `;` — ver mapa en 01) |
| `hs_v2_date_entered_current_stage` | Fecha en que entró a la etapa actual |
| `hs_lastmodifieddate` | Última modificación |
| `notes_last_contacted` | Último contacto registrado |
| `notes_next_activity_date` | Próxima actividad programada |
| `createdate` | Fecha de creación |
| `closedate` | Fecha de cierre |
| `programas_30x` | Programa asociado |
| `deal_source` | Fuente del deal |

> ⚠️ HVM (`hvm_tier`, `hvm_score_total`, `hvm_confidence`, `hvm_scored_at`) vive en el **CONTACTO** asociado al deal, NO en el deal mismo. Usar association lookup para obtenerlo.

### Propiedades condicionales por etapa (Multipliers)

| Etapa | Propiedad | Valores |
|-------|-----------|---------|
| En gestión | `resultado_del_intento_de_contacto` | Contacto logrado / Contacto no logrado |
| Contactado | `resultado_del_contacto_logrado` | Interesado / No interesado |
| Contactado | `califica_para_el_programa` | Sí / No |
| Calificado | `resultado_de_calificaci_n` | Reunión agendada / En negociación / Reserva revisada / Descartar |
| Reunión agendada | `estado_de_la_agenda` | Programada / Terminada / Reprogramada / No asistió / Cancelada |
| Reunión agendada | `cambio_de_agenda` | Reprogramar / Descartar |
| Reunión ocurrida | `resultado_de_reuni_n_completada` | Comprometido / Ganado Pago Parcial / Ganado Pago Total |
| En negociación | `estado_de_la_negociaci_n` | Revisando propuesta / Ganado Pago Parcial / Ganado Pago Total / Descartar |

---

## 5. Definición de Desatendido

**Fuente autoritativa:** Tag `25397556` en `hs_tag_ids`.

Un deal con el tag DESATENDIDO (`25397556`) en su `hs_tag_ids` es oficialmente desatendido. NO usar heurísticas de `notes_last_contacted` como fuente primaria — el tag es la verdad.

**Protocolo:**
- Vendedor: revisar el deal mismo día → contactar + agendar próximo paso (24h) o mover a Cierre perdido.
- Si DESATENDIDO + PRIORITARIO (tag `25397313`) → escalar al líder comercial INMEDIATO.
