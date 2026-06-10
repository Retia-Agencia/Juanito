// src/sheets/aggregate.js
// PURO. Cuenta las entradas dentro de la ventana y las agrupa por categoría.
//
// Recibe `rows` = filas crudas del Sheet (arreglos de celdas, índice 0-based). No
// importa si se cuela la fila de encabezado: su "Submitted At" no parsea y queda
// fuera de la ventana. Los porcentajes de cada categoría se calculan sobre los
// valores NO vacíos de esa categoría (las columnas-pregunta están vacías en filas
// viejas porque el Form evolucionó).

import { CATEGORIES, COL } from './columns.js';
import { parseSubmittedAt } from './parse.js';

export function summarize(rows, { startMs, endMs }, categories = CATEGORIES) {
  const inWindow = (rows || []).filter((row) => {
    const ts = parseSubmittedAt(row?.[COL.submittedAt]);
    return ts != null && ts >= startMs && ts < endMs;
  });

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

  return { total: inWindow.length, breakdown };
}
