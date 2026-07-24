// Tests PUROS del reporte de la AGENDA del día (src/calendly/agenda-report.js): la foto de
// las 7am — cuántas calls tiene agendada cada closer hoy, por programa, aún sin resultados.
//
// Fuente: `calendly_pushes` (una fila por call, vía getScheduledCallsInWindow), NO call_outcomes.
// A las 7am esa otra tabla está vacía por diseño y el reporte nunca salía — ver el encabezado
// del módulo. Estos tests fijan la fuente correcta para que la regresión no vuelva callada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAgendaScorecard, buildAgenda } from '../src/calendly/agenda-report.js';

// Fila de getScheduledCallsInWindow: una call agendada. `closer` es el EMAIL (el reporte
// resuelve el nombre contra el roster) — se usan emails reales de src/calendly/closers.js.
let n = 0;
function call({ program, closer, call_start = '2026-07-24 15:00:00' }) {
  return { event_uuid: `evt-${++n}`, program, closer_email: closer, prospect_name: 'Lead X', call_start };
}

const SEBAS = 'sebastian@30x.com';
const PABLO = 'pablo.lozano@30x.com';
const MARIN = 'sebastian.marin@30x.com';

test('agenda: cuenta calls agendadas hoy por programa y closer', () => {
  const calls = [
    call({ program: 'second_brain', closer: SEBAS }),
    call({ program: 'second_brain', closer: SEBAS }),
    call({ program: 'second_brain', closer: PABLO }),
    call({ program: 'instagram', closer: MARIN }),
  ];
  const msg = formatAgendaScorecard(calls, { dateLabel: 'vie, 24 jul' });
  assert.match(msg, /Agenda del día — vie, 24 jul/);
  assert.match(msg, /4 calls agendadas · 2 programas/);
  assert.match(msg, /\*Sebastian Rodriguez\* — 2 calls/);
  assert.match(msg, /\*Pablo Lozano\* — 1 call/); // singular
  assert.match(msg, /\*Sebastian Marin\* — 1 call/);
});

test('agenda: usa el label del programa desde PROGRAMS, no la key cruda', () => {
  // Regresión: el mapa viejo (PROGRAM_TO_COMPANY) no tenía instagram ni tactical_investor,
  // así que dos programas activos habrían salido con su key técnica en el DM del jefe.
  const msg = formatAgendaScorecard(
    [call({ program: 'instagram', closer: MARIN }), call({ program: 'tactical_investor', closer: SEBAS })],
    {}
  );
  assert.match(msg, /\*Instagram & TikTok\*/);
  assert.match(msg, /\*De Cero a Tactical Investor\*/);
  assert.doesNotMatch(msg, /tactical_investor/);
});

test('agenda: closers ordenados por volumen dentro del programa', () => {
  const calls = [
    call({ program: 'second_brain', closer: PABLO }),
    call({ program: 'second_brain', closer: SEBAS }),
    call({ program: 'second_brain', closer: SEBAS }),
  ];
  const msg = formatAgendaScorecard(calls, {});
  assert.ok(
    msg.indexOf('*Sebastian Rodriguez*') < msg.indexOf('*Pablo Lozano*'),
    'el de más calls va primero'
  );
});

test('agenda: programas ordenados por volumen', () => {
  const calls = [
    call({ program: 'instagram', closer: MARIN }),
    call({ program: 'second_brain', closer: SEBAS }),
    call({ program: 'second_brain', closer: SEBAS }),
  ];
  const { programs } = buildAgenda(calls);
  assert.deepEqual(programs.map((p) => p.key), ['second_brain', 'instagram']);
});

test('agenda: un closer sin mapear igual aparece (no se pierde la cita)', () => {
  const msg = formatAgendaScorecard([call({ program: 'second_brain', closer: 'nadie@ejemplo.com' })], {});
  assert.match(msg, /nadie@ejemplo\.com/);
});

test('agenda: programa nuevo sin cablear cae a su key, no desaparece', () => {
  const { programs } = buildAgenda([call({ program: 'programa_nuevo', closer: SEBAS })]);
  assert.equal(programs.length, 1);
  assert.equal(programs[0].label, 'programa_nuevo');
});

test('agenda: sin calls → null (no manda reporte vacío)', () => {
  assert.equal(formatAgendaScorecard([], {}), null);
  assert.equal(formatAgendaScorecard(undefined, {}), null);
});
