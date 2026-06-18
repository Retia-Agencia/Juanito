// src/sheets/metrics.js
// PURO. Formatea para WhatsApp las "métricas de desempeño" que ya vienen CALCULADAS
// en una pestaña de Google Sheets (otro spreadsheet, §18.N). No agrega ni computa:
// solo lee las filas crudas (arreglo de arreglos de celdas) y las renderiza limpio.
//
// Render genérico (tolerante al layout real, que se afina cuando se vea la pestaña):
//   - fila de 1 celda            → encabezado/sección en *negrita*
//   - fila de 2 celdas           → "• etiqueta: valor"
//   - fila de 3+ celdas          → celdas unidas con " · "
//   - filas totalmente vacías    → se saltan (separan secciones, no se imprimen)

import { zonedParts } from './window.js';

// Fecha del día en Bogotá (DD/MM/YYYY) para rotular el reporte.
function dayLabel(now, tz) {
  const { y, m, d } = zonedParts(now, tz);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d)}/${p(m)}/${y}`;
}

export function formatMetrics(rows, { now = new Date(), tz = 'America/Bogota', title } = {}) {
  const header = title || '📈 Métricas de desempeño';
  const lines = [header, `🗓️ ${dayLabel(now, tz)}`];

  const cells = (row) => (Array.isArray(row) ? row.map((c) => String(c ?? '').trim()) : []);
  const isEmpty = (row) => cells(row).every((c) => c === '');

  const body = (rows || []).filter((r) => !isEmpty(r));
  if (!body.length) {
    lines.push('', 'No hay métricas disponibles hoy.');
    return lines.join('\n');
  }

  lines.push('');
  for (const row of body) {
    // La API de Sheets ya omite las celdas vacías al final de cada fila.
    const c = cells(row);
    if (c.length <= 1) {
      const label = (c[0] || '').trim();
      if (label) lines.push(`*${label}*`); // sección/encabezado
    } else if (c.length === 2) {
      lines.push(`• ${c[0]}: ${c[1]}`);
    } else {
      lines.push(`• ${c.join(' · ')}`);
    }
  }

  return lines.join('\n');
}
