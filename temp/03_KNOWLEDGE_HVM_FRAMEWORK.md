---
name: Framework HVM — 30X
description: Framework de priorización High-Value Matrix. Incluye 11 señales (Bloque 1, max 22pts) + 5 rúbricas R0-R4 (Bloque 2, max 25pts), tiers A+/A/B/C, y reglas de aplicación en el pipeline comercial.
---

# Framework HVM (High Value Member) — 30X

## Resumen

El HVM es el modelo de priorización de 30X para clasificar contactos según su valor potencial. Un agente de scoring calcula automáticamente el tier y lo graba en el **CONTACTO** de HubSpot.

> ⚠️ Las propiedades HVM viven en el objeto **CONTACTO**, NO en el deal. Para obtener el HVM de un deal: deal → association → contacto → leer HVM props.

- **Score máximo teórico (framework):** 47 puntos (22 señales + 25 rúbricas)
- **Rango real de la propiedad:** `hvm_score_total` acepta 0-49 en HubSpot (el campo permite 2 pts extra sobre el framework documentado — puede haber bonus o ajustes del scorer)
- **Propiedad HubSpot (en CONTACTO):** `hvm_tier` (A+, A, B, C)
- **Propiedad score (en CONTACTO):** `hvm_score_total` (0-49)
- **Confianza (en CONTACTO):** `hvm_confidence` (0-1 = % de criterios con dato real)
- **Fecha de scoring (en CONTACTO):** `hvm_scored_at` (timestamp de cuándo se evaluó)

> ⚠️ **Cobertura limitada:** El scorer automático NO ha evaluado a todos los contactos. Muchos tienen `hvm_scored_at` vacío. Si un contacto no tiene `hvm_scored_at`, no ha sido evaluado — no asumir tier por default.

---

## Tiers y Etiquetas

| Tier | Etiqueta | Score | Condiciones | Acción | Tiempo máx |
|------|----------|-------|-------------|--------|------------|
| A+ | 🔴 PRIORITARIO | ≥35 (de 49) | R1≥3 + R4≥4 + señal comercial activa. O R3=5 con score≥28 | Escalar a Andrés HOY. Propuesta 24h. | Mismo día |
| A | 🟠 ALTO VALOR | ≥24 | Señal comercial activa (dolor o pricing) | Contacto humano directo | 24-48h |
| B | 🟡 POTENCIAL | ≥15 | Sin señal clara. R3 alto compensa. | Secuencia follow-up | 2 semanas |
| C | ⚪ NURTURING | <15 | Sin señales ni red | Nurturing automatizado | 60+ días |

**Flag:** ⚠️ DATO INCOMPLETO si `hvm_confidence < 0.5` (menos de 8 de 16 criterios tienen dato real)

---

## Bloque 1 — Señales HVM (máx. 22 pts)

| # | Criterio | Peso | Máx | Qué significa para el vendedor |
|---|----------|------|-----|-------------------------------|
| 1 | Facturación estimada | ALTO | 3 | Empresa grande = más probabilidad de compra y más valor |
| 2 | Poder de decisión presupuesto | ALTO | 2 | Si decide solo, el cierre es más rápido |
| 3 | Ha pagado programas premium (>$2K) | MEDIO | 1 | Ya sabe invertir en educación ejecutiva |
| 4 | Sector operativo (fit red 30X) | ALTO | 2 | Su sector encaja con la comunidad 30X |
| 5 | Tiene equipo candidato a 30X | ALTO | 2 | Potencial de múltiples ventas |
| 6 | Nivel participación Inmersivo | MEDIO | 2 | Más participación = más interés real |
| 7 | Conectó con mentores / pidió follow-up | MEDIO | 2 | Señal de engagement genuino |
| 8 | Mencionó dolor de negocio concreto | CRÍTICO | 3 | **Más predictivo.** Dolor real = necesidad real |
| 9 | Preguntó por pricing / programas | CRÍTICO | 3 | **Más predictivo.** Intención de compra activa |
| 10 | Refirió a alguien | ALTO | 2 | Ya piensa en traer a otros (bonus) |
| 11 | Tiene audiencia / referente | MEDIO | 2 | Influencia en su industria (bonus) |

> ⚠️ Si criterios 8 y 9 = 0 → rara vez llega a Tier A.

---

## Bloque 2 — Rúbricas R0-R4 (máx. 25 pts)

### R0 — Qué hace la compañía (1-5 pts)
*"Si le explico a Andrés qué hace, ¿le interesa?"*
- 1 = Negocio confuso, freelancer
- 2 = Local, nicho chico
- 3 = Claro, sector relevante, sin diferenciación
- 4 = Sector con demanda, escalable
- 5 = Sector caliente (AI, fintech, SaaS)

### R1 — Ventas últimos 3 años (1-5 pts)
*"¿Justifica mi tiempo?"*
- 1 = <$200K USD/año
- 2 = $200K-$1M (DEFAULT si no hay dato)
- 3 = $1M-$5M o crecimiento >30%
- 4 = $5M-$20M, consolidada
- 5 = >$20M o crecimiento >100% YoY

### R2 — Calidad del equipo (1-5 pts)
*"¿Lo invitaría a dar charla en un Inmersivo?"*
- 1 = Fundador solo, sin track record
- 2 = Equipo pequeño, promedio
- 3 = Competente pero no excepcional
- 4 = Fuerte: ex-corporativo, founders con exit
- 5 = Clase mundial. C-suite, serial entrepreneurs

### R3 — Vínculos y red — WILDCARD (1-5 pts)
*"¿Me puede abrir puertas que un cold email no?"*
- 1 = Sin conexiones relevantes
- 2 = Conexiones locales
- 3 = Conectado en su sector
- 4 = Acceso a grupos empresariales, fondos
- 5 = **NODO DE RED.** Conector entre clusters de poder

> 🃏 R3=5 es WILDCARD: empresa chica con R3=5 + score≥28 → A+ (Ultra High Value). Tier B con R3=5 tiene prioridad sobre Tier A con R3 bajo.

### R4 — Calidad percibida por 30X (1-5 pts)
*"Si Andrés o Dylan lo conocieran, ¿dirían 'con este quiero hacer algo'?"*
- 1 = Mala impresión
- 2 = Neutral
- 3 = Buena impresión
- 4 = Destaca. Energía, ambición
- 5 = Wow factor. Caso de éxito potencial

---

## Reglas de Aplicación

1. **Score con lo que sabes, no imagines.** Sin dato → R1 = 2
2. **R3 es wildcard.** Empresa chica + R3=5 = puede ser Ultra High Value
3. **R4 se calibra en equipo.** Discrepancia → promediar
4. **Criterios 8+9 son los más predictivos.** Ambos en 0 → rara vez Tier A
5. **Se llena inmediatamente post-evento**

---

## Etiqueta DESATENDIDO

No depende del HVM sino del comportamiento del vendedor.

**Fuente autoritativa:** Tag `25397556` en `hs_tag_ids` del deal. NO usar heurísticas.

**Protocolo:**
- Vendedor: revisar el deal mismo día → contactar + agendar próximo paso (24h) o mover a Cierre perdido
- Si DESATENDIDO + PRIORITARIO (tag `25397313`) → escalar al líder comercial INMEDIATO

**Se quita:** automáticamente al registrar contacto nuevo + agendar próximo paso.
