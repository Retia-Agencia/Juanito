// src/sheets/metrics.js
// PURO. Formatea para WhatsApp el "Resumen Semanal — Show rate por closer" (§18.N),
// que vive en una pestaña de otro spreadsheet con las métricas YA CALCULADAS.
//
// Layout real de la pestaña (filas = arreglos de celdas que devuelve la API):
//   - filas de título / instrucciones (se ignoran)
//   - "Filtrar semana: <n>"  → número de semana
//   - secciones por empresa:  fila con sólo "30X" o "ESTADOX" en la col A
//   - fila de encabezado de tabla: col A = "#"
//   - filas de closer: col A = número (rank). Columnas:
//       0 #  · 1 Closer · 2 Agendados · 3 Shows · 4 Show Rate Total ·
//       5 Pushes 3/3 · 6 Shows 3/3 · 7 Show Rate 3/3 · 8 Shows <4 ·
//       9 Show Rate <4 · 10 Delta · 11 Interpretación
//
// Si la estructura no coincide (cambió la pestaña), cae a un volcado genérico para
// no enviar un reporte vacío en silencio.

import { zonedParts } from './window.js';

function dayLabel(now, tz) {
  const { y, m, d } = zonedParts(now, tz);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d)}/${p(m)}/${y}`;
}

const cellsOf = (row) => (Array.isArray(row) ? row.map((c) => String(c ?? '').trim()) : []);
const COMPANIES = new Set(['30X', 'ESTADOX']);

export function formatMetrics(rows, { now = new Date(), tz = 'America/Bogota', title } = {}) {
  const data = Array.isArray(rows) ? rows : [];

  // Semana (de la fila "Filtrar semana: <n>").
  let week = null;
  for (const r of data) {
    const c = cellsOf(r);
    const i = c.findIndex((x) => /filtrar semana/i.test(x));
    if (i !== -1) {
      week = c.slice(i + 1).find((x) => /^\d+$/.test(x)) || null;
      break;
    }
  }

  const lines = [title || '📈 Métricas del día — Show rate por closer'];
  lines.push(week ? `🗓️ Semana ${week}` : `🗓️ ${dayLabel(now, tz)}`);

  let any = false;
  for (const r of data) {
    const c = cellsOf(r);
    const first = (c[0] || '').trim();

    // Encabezado de sección (empresa).
    if (COMPANIES.has(first.toUpperCase()) && c.slice(1).every((x) => x === '')) {
      lines.push('', `*${first.toUpperCase()}*`);
      continue;
    }

    // Fila de closer (rank numérico en col A + nombre en col B).
    if (/^\d+$/.test(first) && c[1]) {
      const closer = c[1];
      const agendados = c[2] || '0';
      const shows = c[3] || '0';
      const srTotal = c[4] || '—';
      const sr33 = c[7] || '—';
      const sr4 = c[9] || '—';
      const delta = c[10] || '';

      if (agendados === '0' && shows === '0') {
        lines.push(`• ${closer} — sin datos`);
      } else {
        let line = `• ${closer} — ${shows}/${agendados} shows (${srTotal}) · 3/3: ${sr33} · <4: ${sr4}`;
        if (delta && delta !== '0.0%') line += ` · Δ ${delta}`;
        lines.push(line);
      }
      any = true;
    }
  }

  // Fallback: la estructura no coincidió → volcado genérico de filas no vacías.
  if (!any) {
    const body = data.filter((r) => cellsOf(r).some((x) => x !== ''));
    if (!body.length) {
      lines.push('', 'No hay métricas disponibles hoy.');
      return lines.join('\n');
    }
    lines.push('');
    for (const r of body) {
      const c = cellsOf(r);
      if (c.length === 2) lines.push(`• ${c[0]}: ${c[1]}`);
      else if (c.length === 1) lines.push(`*${c[0]}*`);
      else lines.push(`• ${c.join(' · ')}`);
    }
  }

  return lines.join('\n');
}
