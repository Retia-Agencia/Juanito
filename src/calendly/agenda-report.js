// src/calendly/agenda-report.js
// PURO (sin red, sin DB → testeable en Windows). El reporte de la MAÑANA (7am): la AGENDA
// del día — cuántas calls tiene reservada cada closer para HOY, por programa. Aún sin
// resultados (a las 7am nada ocurrió todavía): es la foto de lo que viene, no un scorecard.
//
// Sale de `call_outcomes` igual que el reporte del jefe: cada Push crea una fila 'pending'
// al reservar la call, así que a las 7am ya están las calls agendadas para hoy. Reusa
// buildBossScorecard (misma consolidación empresa→programa→closer) y solo cuenta el volumen.
//
// Regla de conteo (§18.AC), heredada: una call reagendada/cancelada NO ocurrió → no entra en
// el volumen (`total` ya las excluye). Por eso una reagenda hecha antes de las 7am no infla
// la agenda del día.

import { buildBossScorecard } from './boss-report.js';

const plural = (n, sing, plu = sing + 's') => (n === 1 ? sing : plu);

// Formatea el DM de la agenda del día. `rows` = call_outcomes de la ventana de hoy.
// Devuelve el texto, o null si no hay ninguna call agendada (no manda reporte vacío).
export function formatAgendaScorecard(rows = [], { dateLabel = 'hoy' } = {}) {
  const { company, programs } = buildBossScorecard(rows);
  if (!programs.length || !company.total) return null;

  const head =
    `🗓️ *Agenda del día — ${dateLabel}*\n` +
    `${company.total} ${plural(company.total, 'call')} agendada${company.total === 1 ? '' : 's'} · ` +
    `${programs.length} ${plural(programs.length, 'programa')}`;

  const sections = programs
    .filter((p) => p.total > 0)
    .map((p) => {
      // Para la agenda ordenamos por volumen (aún no hay ventas/shows que rankear).
      const closerLines = p.closers
        .filter((s) => s.total > 0)
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
        .map((s) => `   • *${s.name}* — ${s.total} ${plural(s.total, 'call')}`);
      return `*${p.company}* — ${p.total} ${plural(p.total, 'call')}\n` + closerLines.join('\n');
    });

  return `${head}\n\n${sections.join('\n\n')}`;
}
