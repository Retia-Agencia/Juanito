// src/sheets/aggregate.js
// PURO. Cuenta las entradas dentro de la ventana y las agrupa por categoría.
//
// Recibe `rows` = filas crudas del Sheet (arreglos de celdas, índice 0-based). No
// importa si se cuela la fila de encabezado: su "Submitted At" no parsea y queda
// fuera de la ventana. Los porcentajes de cada categoría se calculan sobre los
// valores NO vacíos de esa categoría (las columnas-pregunta están vacías en filas
// viejas porque el Form evolucionó).

import { CATEGORIES, COL, SETTEO } from './columns.js';
import { parseSubmittedAt, SETTEO_AHEAD_HOURS } from './parse.js';
import { computeWindow } from './window.js';

const DAY_MS = 24 * 3600 * 1000;

const isFilled = (v) => v != null && String(v).trim() !== '';

export function summarize(rows, { startMs, endMs }, categories = CATEGORIES) {
  const inWindow = (rows || []).filter((row) => {
    const ts = parseSubmittedAt(row?.[COL.submittedAt]);
    return ts != null && ts >= startMs && ts < endMs;
  });

  // Bookings de Calendly: col I (URL de invitee) no vacía dentro de la ventana.
  const calendlyBooked = inWindow.reduce(
    (n, row) => n + (isFilled(row?.[COL.calendly]) ? 1 : 0),
    0
  );

  const breakdown = categories.map((cat) => {
    const counts = new Map();
    let answered = 0; // filas con esta categoría respondida (no vacía)

    for (const row of inWindow) {
      const raw = row?.[cat.col];
      if (raw == null || String(raw).trim() === '') continue;
      const val = cat.normalize ? cat.normalize(String(raw)) : String(raw).trim();
      if (val === '') continue;
      counts.set(val, (counts.get(val) || 0) + 1);
      answered += 1;
    }

    const items = [...counts.entries()]
      .map(([value, count]) => ({
        value,
        count,
        pct: answered ? Math.round((count / answered) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'es'));

    return { key: cat.key, label: cat.label, answered, items };
  });

  return { total: inWindow.length, breakdown, calendlyBooked };
}

// Cuenta los self-checkout del tab "📞 Setteo Pendiente" dentro de la ventana.
// `rows` = filas crudas de ese tab (encabezado incluido; no parsea como fecha → fuera).
// Filtra por col A ("Fecha detección", DD/MM/YYYY H:MM) y devuelve:
//   - `reached`: cuántos LLEGARON al self-checkout (toda fila del pipeline en la
//     ventana, con o sin pago — col G no vacía).
//   - `paid`: de esos, cuántos SÍ pagaron (col G = "💳 Self-checkout"; los
//     "No hizo self-checkout" llegaron pero no pagaron).
export function countSelfCheckout(rows, { startMs, endMs }, aheadHours = SETTEO_AHEAD_HOURS()) {
  let reached = 0;
  let paid = 0;
  for (const row of rows || []) {
    const ts = parseSubmittedAt(row?.[SETTEO.fecha], aheadHours);
    if (ts == null || ts < startMs || ts >= endMs) continue;
    const estado = String(row?.[SETTEO.estadoPago] ?? '').trim();
    if (estado === '') continue; // fila sin estado de pago → no es una entrada del pipeline
    reached += 1;
    if (/self-?checkout/i.test(estado) && !/no\s+hizo/i.test(estado)) paid += 1;
  }
  return { reached, paid };
}

// Promedio diario de las tres métricas de funnel sobre los `days` días PREVIOS a
// `now` (EXCLUYE el día de `now`) → línea base para comparar el dato de hoy.
// ⚠️ Sin uso en el reporte desde 2026-07-09 (el owner pidió quitar el prom. 7d;
// la comparación histórica ahora es el bloque semanal). Se conserva por si vuelve. Reusa
// `summarize` + `countSelfCheckout` por cada ventana diaria. Devuelve promedios sin
// redondear (el formateo decide los decimales). Sin costo de red: opera sobre las
// mismas filas ya leídas.
export function averagePriorDays(rows, setteoRows, now, days = 7) {
  let total = 0;
  let calendly = 0;
  let reached = 0;
  let paid = 0;
  for (let k = 1; k <= days; k++) {
    const win = computeWindow(new Date(now.getTime() - k * DAY_MS));
    const s = summarize(rows, win);
    const sc = countSelfCheckout(setteoRows, win);
    total += s.total;
    calendly += s.calendlyBooked;
    reached += sc.reached;
    paid += sc.paid;
  }
  return {
    days,
    total: total / days,
    calendly: calendly / days,
    reached: reached / days,
    paid: paid / days,
  };
}

// Cuenta estudiantes confirmados de la cohorte: la RACHA de filas con la columna A
// (nombre completo) no vacía, arrancando en la fila 1 (la 0 es el encabezado del tab).
// La primera fila vacía CORTA el conteo — no se sigue mirando lo que haya debajo.
// Sin PII: solo devuelve el número.
//
// ⚠️ El corte por racha no es cosmético (2026-08-25). Abajo de la lista de confirmados
// el equipo escribe secciones a mano en la MISMA columna A — "COMPROMISOS DE PAGO:" en
// septiembre, "Compromisos verbales:" en agosto — y debajo de ese rótulo van personas que
// todavía NO pagaron. Contando toda fila con nombre (la regla vieja), septiembre reportaba
// 27 cuando los confirmados eran 21: 5 compromisos + el rótulo, que es indistinguible de
// un estudiante porque también es texto en la columna A. La fila en blanco que separa la
// lista de la sección es lo ÚNICO que el Sheet ofrece como frontera, así que esa es la
// regla. Si alguien llena esa fila en blanco, el conteo vuelve a inflarse — por eso el
// reporte de §18.B se compara contra el Sheet cuando el número salta de golpe.
//
// NO deduplica: un mismo nombre repetido dentro de la racha cuenta tantas veces como
// aparezca (agosto tenía uno triplicado). Es a propósito — un duplicado es un error de
// carga del equipo y esconderlo acá lo vuelve invisible en vez de arreglarlo.
export function countCohortStudents(rows) {
  const body = (rows || []).slice(1);
  let n = 0;
  for (const row of body) {
    if (String(row?.[0] ?? '').trim() === '') break;
    n += 1;
  }
  return n;
}
