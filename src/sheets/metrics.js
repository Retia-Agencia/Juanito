// src/sheets/metrics.js
// PURO. Formatea para WhatsApp el "Resumen Diario — Show rate por closer" (§18.N),
// que vive en una pestaña de otro spreadsheet con las métricas YA CALCULADAS.
//
// Soporta dos modos:
//   - completo (sin `company`): ambas secciones (30X + ESTADOX) → preview /reportes metricas.
//   - por empresa (`company: '30X'|'ESTADOX'`): SOLO esa sección → se enruta a su grupo.
//
// Layout de la pestaña: filas = arreglos de celdas. Secciones por empresa (fila con
// sólo "30X"/"ESTADOX" en col A), encabezado de tabla (col A = "#"), filas de closer
// (col A = rank numérico). Columnas: 0 # · 1 Closer · 2 Agendados · 3 Shows ·
// 4 Show Rate Total · 7 Show Rate 3/3 · 9 Show Rate <4 · 10 Delta.

import { zonedParts } from './window.js';

function dayLabel(now, tz) {
  const { y, m, d } = zonedParts(now, tz);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d)}/${p(m)}/${y}`;
}

const cellsOf = (row) => (Array.isArray(row) ? row.map((c) => String(c ?? '').trim()) : []);
const COMPANIES = new Set(['30X', 'ESTADOX']);

// Línea de un closer a partir de su fila de celdas.
function closerLine(c) {
  const closer = c[1];
  const agendados = c[2] || '0';
  const shows = c[3] || '0';
  const srTotal = c[4] || '—';
  const sr33 = c[7] || '—';
  const sr4 = c[9] || '—';
  const delta = c[10] || '';
  if (agendados === '0' && shows === '0') return `• ${closer} — sin datos`;
  let line = `• ${closer} — ${shows}/${agendados} shows (${srTotal}) · 3/3: ${sr33} · <4: ${sr4}`;
  if (delta && delta !== '0.0%') line += ` · Δ ${delta}`;
  return line;
}

// Extrae la semana (si la pestaña la tiene) y las secciones por empresa.
function parse(data) {
  let week = null;
  for (const r of data) {
    const c = cellsOf(r);
    const i = c.findIndex((x) => /filtrar semana/i.test(x));
    if (i !== -1) {
      week = c.slice(i + 1).find((x) => /^\d+$/.test(x)) || null;
      break;
    }
  }
  const sections = [];
  let cur = null;
  for (const r of data) {
    const c = cellsOf(r);
    const first = (c[0] || '').trim();
    if (COMPANIES.has(first.toUpperCase()) && c.slice(1).every((x) => x === '')) {
      cur = { company: first.toUpperCase(), rows: [] };
      sections.push(cur);
      continue;
    }
    if (/^\d+$/.test(first) && c[1] && cur) cur.rows.push(c);
  }
  return { week, sections };
}

export function formatMetrics(rows, { now = new Date(), tz = 'America/Bogota', title, company } = {}) {
  const data = Array.isArray(rows) ? rows : [];
  const { week, sections } = parse(data);
  const dateLine = week ? `🗓️ Semana ${week}` : `🗓️ ${dayLabel(now, tz)}`;

  // Modo por empresa: una sola sección → su grupo destino.
  if (company) {
    const comp = String(company).toUpperCase();
    const sec = sections.find((s) => s.company === comp);
    const lines = [title || `📈 Métricas del día — ${comp}`, dateLine, ''];
    if (!sec || !sec.rows.length) {
      lines.push(`No hay métricas para ${comp} hoy.`);
      return lines.join('\n');
    }
    for (const c of sec.rows) lines.push(closerLine(c));
    return lines.join('\n');
  }

  // Modo completo: todas las secciones.
  const lines = [title || '📈 Métricas del día — Show rate por closer', dateLine];
  if (sections.length) {
    for (const s of sections) {
      lines.push('', `*${s.company}*`);
      for (const c of s.rows) lines.push(closerLine(c));
    }
    return lines.join('\n');
  }

  // Fallback genérico (la estructura no coincidió) → volcado de filas no vacías.
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
  return lines.join('\n');
}
