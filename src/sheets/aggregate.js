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
