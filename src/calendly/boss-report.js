// src/calendly/boss-report.js
// PURO (sin red, sin DB → testeable en Windows). El reporte del JEFE (Dani): una sola
// vista que consolida TODOS los programas y TODOS los closers desde `call_outcomes`.
//
// A diferencia de outcome-report.js (que publica UNA sección por programa a su grupo de
// WhatsApp), este arma un scorecard único para el DM de Dani: totales de empresa arriba,
// luego cada programa con su desglose por closer, ordenados por ventas.
//
// Fuente ÚNICA: `call_outcomes` (Push 4 + la cosecha por agenda_status, §18.AG). No re-deriva
// HubSpot ni Stripe: todo desemboca en call_outcomes y este reporte lee de ahí. Muestra
// número de ventas (conteo, NO plata) y una línea de COBERTURA del dato — sin ella, un 88%
// de calls "sin registrar" haría leer ficción como realidad (regla: no mentir con confianza).
//
// Regla de conteo (§18.AC), heredada de aggregateOutcomes: una call reagendada o cancelada
// NO ocurrió → va a "movidas", no al volumen. Evita el doble conteo.

import { aggregateOutcomes, PROGRAM_TO_COMPANY } from './outcome-report.js';

// Orden de presentación de los programas (los no listados van al final, alfabético).
const PROGRAM_ORDER = ['second_brain', 'abogados', 'linkedin', 'developers', 'operaciones', 'instagram'];

function pct(num, den) {
  if (!den) return 0;
  return Math.round((num / den) * 100);
}

const ACC_KEYS = ['total', 'registrados', 'sin_registrar', 'show', 'no_show', 'reagendado', 'cancelado', 'venta_cerrada'];

// Consolida filas crudas de call_outcomes en la estructura del reporte del jefe:
//   { company: {…totales…, show_rate, cobertura}, programs: [{ key, company, …totales,
//     show_rate, cobertura, closers: [{ name, …stats }] }] }
// Reusa aggregateOutcomes (misma semántica que el reporte por grupo) y suma hacia arriba.
export function buildBossScorecard(rows = []) {
  const byProgram = aggregateOutcomes(rows);
  const company = Object.fromEntries(ACC_KEYS.map((k) => [k, 0]));
  const seen = Object.keys(byProgram);
  const order = [...PROGRAM_ORDER.filter((p) => byProgram[p]), ...seen.filter((p) => !PROGRAM_ORDER.includes(p)).sort()];

  const programs = [];
  for (const prog of order) {
    const closers = byProgram[prog];
    const pt = {
      key: prog,
      company: PROGRAM_TO_COMPANY[prog] || prog,
      ...Object.fromEntries(ACC_KEYS.map((k) => [k, 0])),
      closers: [],
    };
    for (const [name, s] of Object.entries(closers)) {
      for (const k of ACC_KEYS) pt[k] += s[k] || 0;
      pt.closers.push({ name, ...s });
    }
    pt.show_rate = pct(pt.show, pt.show + pt.no_show);
    pt.cobertura = pct(pt.registrados, pt.total);
    // Ranking del closer: ventas → shows → volumen.
    pt.closers.sort((a, b) => b.venta_cerrada - a.venta_cerrada || b.show - a.show || b.total - a.total);
    programs.push(pt);
    for (const k of ACC_KEYS) company[k] += pt[k];
  }
  company.show_rate = pct(company.show, company.show + company.no_show);
  company.cobertura = pct(company.registrados, company.total);
  return { company, programs };
}

const plural = (n, sing, plu = sing + 's') => (n === 1 ? sing : plu);

// Formatea el DM del jefe. `rows` = call_outcomes de la ventana. Devuelve el texto, o null
// si no hubo ninguna call en el período.
export function formatBossScorecard(rows = [], { dateLabel = 'hoy' } = {}) {
  const { company, programs } = buildBossScorecard(rows);
  if (!programs.length) return null;

  const movidas = company.reagendado + company.cancelado;
  const head =
    `📊 *Reporte Juanito — ${dateLabel}*\n` +
    `${company.total} ${plural(company.total, 'call')} · ` +
    `${company.show} show · ${company.no_show} no-show · show ${company.show_rate}%\n` +
    `🎯 ${company.venta_cerrada} ${plural(company.venta_cerrada, 'venta')}` +
    (movidas ? ` · 🔁 ${movidas} ${plural(movidas, 'movida')}` : '') +
    `\n📶 cobertura del dato: ${company.cobertura}%` +
    (company.sin_registrar ? ` (${company.sin_registrar} sin registrar)` : '');

  const sections = programs.map((p) => {
    const closerLines = p.closers.map((s) => {
      const det = [s.show ? `${s.show} show` : null, s.no_show ? `${s.no_show} no-show` : null]
        .filter(Boolean)
        .join(' · ');
      const mov = s.movidas ? `  🔁 ${s.movidas}` : '';
      const ventas = s.venta_cerrada ? `  🎯 ${s.venta_cerrada}` : '';
      const falta = s.sin_registrar ? `  ⚠️ ${s.sin_registrar} sin registrar` : '';
      return `   • *${s.name}* — ${s.total} ${plural(s.total, 'call')} · ${det || 'sin estados'}${ventas}${mov}${falta}`;
    });
    return (
      `*${p.company}* — ${p.total} ${plural(p.total, 'call')} · show ${p.show_rate}% · ` +
      `🎯 ${p.venta_cerrada} · 📶 ${p.cobertura}%\n` +
      closerLines.join('\n')
    );
  });

  const footer =
    company.cobertura < 100
      ? `\n\n_Cobertura <100%: las calls sin registrar no entran en show/ventas — el dato real puede ser mayor._`
      : '';

  return `${head}\n\n${sections.join('\n\n')}${footer}`;
}
