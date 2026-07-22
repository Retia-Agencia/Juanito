// Tests PUROS del reporte de la AGENDA del día (src/calendly/agenda-report.js): la foto de
// las 7am — cuántas calls tiene agendada cada closer hoy, por programa, aún sin resultados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAgendaScorecard } from '../src/calendly/agenda-report.js';

// Fila de call_outcomes mínima. A las 7am las calls están 'pending' (aún sin asistencia).
function row({ program, closer, asistencia = null, status = 'pending', rescheduled_to = null }) {
  return {
    program,
    closer_name: closer,
    closer_email: `${closer}@30x.com`,
    asistencia,
    resultado: null,
    status,
    lead_name: 'Lead X',
    rescheduled_to,
  };
}

test('agenda: cuenta calls agendadas hoy por programa y closer', () => {
  const rows = [
    row({ program: 'second_brain', closer: 'Sebas' }),
    row({ program: 'second_brain', closer: 'Sebas' }),
    row({ program: 'second_brain', closer: 'Ana' }),
    row({ program: 'linkedin', closer: 'Marin' }),
  ];
  const msg = formatAgendaScorecard(rows, { dateLabel: 'mié, 22 jul' });
  assert.match(msg, /Agenda del día — mié, 22 jul/);
  assert.match(msg, /4 calls agendadas · 2 programas/);
  assert.match(msg, /\*Sebas\* — 2 calls/);
  assert.match(msg, /\*Ana\* — 1 call/); // singular
  assert.match(msg, /\*Marin\* — 1 call/);
});

test('agenda: closers ordenados por volumen dentro del programa', () => {
  const rows = [
    row({ program: 'second_brain', closer: 'Ana' }),
    row({ program: 'second_brain', closer: 'Sebas' }),
    row({ program: 'second_brain', closer: 'Sebas' }),
  ];
  const msg = formatAgendaScorecard(rows, {});
  assert.ok(msg.indexOf('*Sebas*') < msg.indexOf('*Ana*'), 'el de más calls va primero');
});

test('agenda: reagendada/cancelada antes de las 7am NO inflan la agenda', () => {
  const rows = [
    row({ program: 'linkedin', closer: 'Lucas' }),
    row({ program: 'linkedin', closer: 'Lucas', asistencia: 'reagendado', status: 'auto', rescheduled_to: '2026-07-23 15:30:00' }),
    row({ program: 'linkedin', closer: 'Lucas', asistencia: 'cancelado', status: 'auto' }),
  ];
  const msg = formatAgendaScorecard(rows, {});
  assert.match(msg, /1 call agendada · 1 programa/);
  assert.match(msg, /\*Lucas\* — 1 call/);
});

test('agenda: sin calls → null (no manda reporte vacío)', () => {
  assert.equal(formatAgendaScorecard([], {}), null);
  // Solo movidas (nada que de verdad ocurra hoy) tampoco dispara reporte.
  const soloMovidas = [row({ program: 'linkedin', closer: 'Lucas', asistencia: 'cancelado', status: 'auto' })];
  assert.equal(formatAgendaScorecard(soloMovidas, {}), null);
});
