---
name: Pipeline de Leads — Multipliers
description: Pipeline de leads pre-webinar para Multipliers. 6 etapas desde Potencial hasta Asistió a webinar, con IDs de etapas, 13 propiedades custom, y reglas de avance.
---

# Pipeline de Leads — Multipliers (Pre-Webinar)

> Pipeline ID: 905179198
> Programa: Multipliers
> Última actualización: 2 junio 2026

---

## Concepto

El Pipeline de Leads maneja la fase de prospección ANTES del webinar. El objetivo es:
1. Recibir leads (potenciales)
2. Gestionarlos comercialmente
3. Conseguir que se registren al webinar
4. Confirmar su asistencia
5. Verificar que asistieron

**Cuando el lead ASISTE al webinar → se convierte en Deal** en el Pipeline de Deals.

---

## Etapas

| # | Etapa | Stage ID | Descripción |
|---|-------|----------|-------------|
| 1 | Potencial | 1369952117 | Lead recién ingresado |
| 2 | En gestión | 1369952118 | Se inició contacto |
| 3 | Contacto efectivo | 1369952119 | Contacto logrado exitosamente |
| 4 | Registrado webinar | 1369952120 | Se registró al webinar |
| 5 | Confirmación de webinar | 1369952121 | Confirmó que asistirá |
| 6 | Asistió a webinar | 1369952558 | Asistió al webinar → crear Deal |

---

## Propiedades del Lead

| Propiedad | Tipo | Uso |
|-----------|------|-----|
| cargo | Texto | Cargo del contacto |
| empresa | Texto | Empresa del lead |
| cohorte_inmersivo | Texto | Cohorte del inmersivo |
| registrado_en_webinar | Booleano | ¿Se registró al webinar? |
| confirmo_asistencia_a_webinar | Booleano | ¿Confirmó asistencia? |
| asistio_a_webinar | Booleano | ¿Asistió al webinar? |
| resultado_del_intento_de_contacto | Enumeración | Resultado del primer contacto |
| resultado_del_contacto | Enumeración | Resultado del contacto efectivo |
| motivo_de_no_interes | Texto | Por qué no le interesa |
| proximo_contacto | Fecha | Siguiente contacto programado |
| hubspot_owner_id | Owner | Vendedor asignado |

---

## Flujo Lead → Deal

```
Lead asiste a webinar
  → Se marca asistio_a_webinar = true
  → Lead avanza a "Asistió a webinar"
  → Se crea Deal automáticamente en Pipeline de Deals (etapa "Potencial")
  → El vendedor continúa gestión en el Pipeline de Deals
```

---

## Datos actuales (junio 2026)
- 363 leads totales en Multipliers
- 343 en etapa Potencial
- 19 en Registrado webinar
- 1 en Confirmación
- Valor por deal (si convierte): US$24,000
