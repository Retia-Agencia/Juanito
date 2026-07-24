// src/calendly/agenda-report.js
// PURO (sin red, sin DB → testeable en Windows). El reporte de la MAÑANA (7am): la AGENDA
// del día — cuántas calls tiene reservada cada closer para HOY, por programa. Aún sin
// resultados (a las 7am nada ocurrió todavía): es la foto de lo que viene, no un scorecard.
//
// FUENTE: `calendly_pushes` (vía getScheduledCallsInWindow), una fila por call.
//
// ⚠️ Antes leía `call_outcomes` como el reporte del jefe, con la premisa de que "cada Push crea
// una fila 'pending' al reservar la call". Esa premisa era FALSA: la fila nace recién cuando se
// ENTREGA el Push 4, ~45 min DESPUÉS de que la call termina (scheduler/calendly.js, "el
// pendiente se crea recién ahora"). A las 7am ninguna call del día terminó → la tabla estaba
// vacía → `formatAgendaScorecard` devolvía null y el reporte NUNCA se envió, sin error en los
// logs. Verificado en producción el 2026-07-24: 0 filas en call_outcomes a las 7am (ayer y hoy)
// contra 39 calls realmente agendadas. `calendly_pushes` es la única fuente que existe a esa
// hora, porque el poll reserva los pushes al aparecer la cita.
//
// Regla de conteo: las calls que ya no van (canceladas, reagendadas, reagenda manual superseded
// por el evento real) quedan con TODOS sus pushes en 'skipped' y las excluye la query — así una
// reagenda no se cuenta dos veces. El detalle vive en getScheduledCallsInWindow.

import { PROGRAM_LABELS } from './programs.js';
import { resolveCloser } from './closers.js';

const plural = (n, sing, plu = sing + 's') => (n === 1 ? sing : plu);

// Etiqueta del programa desde el registro PROGRAMS (fuente única, ADR 0001). Un programa
// nuevo aún sin cablear cae a su key cruda en vez de desaparecer del reporte.
const labelOf = (key) => PROGRAM_LABELS[key] || key || 'sin programa';

// Nombre del closer desde el roster; sin match, el email (visible pero no bonito) para que
// una cita de alguien sin mapear no se pierda de la agenda.
const closerNameOf = (email) => resolveCloser(email)?.name || email || 'sin closer';

// Consolida las calls agendadas en programa → closer, ordenado por volumen.
// `calls` = filas de getScheduledCallsInWindow ({ program, closer_email, … }).
// Devuelve { total, programs: [{ key, label, total, closers: [{ name, total }] }] }.
export function buildAgenda(calls = []) {
  const byProgram = new Map();
  for (const c of calls) {
    const key = c.program || null;
    if (!byProgram.has(key)) byProgram.set(key, new Map());
    const closers = byProgram.get(key);
    const name = closerNameOf(c.closer_email);
    closers.set(name, (closers.get(name) || 0) + 1);
  }

  const programs = [...byProgram.entries()]
    .map(([key, closers]) => ({
      key,
      label: labelOf(key),
      total: [...closers.values()].reduce((a, b) => a + b, 0),
      closers: [...closers.entries()]
        .map(([name, total]) => ({ name, total }))
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
    }))
    // En una agenda no hay ventas ni shows que rankear: manda el volumen.
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));

  return { total: programs.reduce((a, p) => a + p.total, 0), programs };
}

// Formatea el DM de la agenda del día. `calls` = una fila por call agendada hoy.
// Devuelve el texto, o null si no hay ninguna (no manda reporte vacío).
export function formatAgendaScorecard(calls = [], { dateLabel = 'hoy' } = {}) {
  const { total, programs } = buildAgenda(calls);
  if (!total) return null;

  const head =
    `🗓️ *Agenda del día — ${dateLabel}*\n` +
    `${total} ${plural(total, 'call')} agendada${total === 1 ? '' : 's'} · ` +
    `${programs.length} ${plural(programs.length, 'programa')}`;

  const sections = programs.map((p) => {
    const closerLines = p.closers.map((s) => `   • *${s.name}* — ${s.total} ${plural(s.total, 'call')}`);
    return `*${p.label}* — ${p.total} ${plural(p.total, 'call')}\n` + closerLines.join('\n');
  });

  return `${head}\n\n${sections.join('\n\n')}`;
}
