// Tests PUROS de la detección de reagendas hechas dentro del CRM
// (src/hubspot/reschedule-detect.js).
//
// Acá el riesgo es el CONTRARIO al de agenda-poll: no es mandar un push de más, es CANCELAR el
// push de una call que sí va a ocurrir y dejar al closer entrando en frío a una llamada real.
// Por eso la mayoría de estos tests fijan casos donde NO hay que cancelar — cada uno sale de un
// patrón visto en producción, no de un escenario inventado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRescheduledAway, callKey, MIN_REBOOK_GAP_MIN } from '../src/hubspot/reschedule-detect.js';

const NOW = Date.parse('2026-07-20T12:00:00Z');

// Cita del mismo lead. Por default: futura, second_brain, del mismo closer.
const cita = (over = {}) => ({
  meeting_id: 'm-vieja',
  contact_id: 'c1',
  program: 'second_brain',
  closer_email: 'pablo.lozano@30x.com',
  call_start: '2026-07-22 16:30:00',
  created_at: '2026-07-19T04:42:00Z',
  prospect_name: 'Entrevista de Postulación Programa AI Second Brain',
  ...over,
});

// La reagenda real: creada bastante después que la original, para otra hora.
const reagenda = (over = {}) =>
  cita({
    meeting_id: 'm-nueva',
    call_start: '2026-07-23 17:45:00',
    created_at: '2026-07-20T11:35:00Z', // ~31 h después de la original
    ...over,
  });

const escenario = (nueva, hermanas, nowMs = NOW) =>
  pickRescheduledAway({
    nuevas: [nueva],
    siblingsByContact: { [nueva.contact_id]: [nueva, ...hermanas] },
    nowMs,
  });

// ─── El caso que justifica el feature ─────────────────────────────────────────

test('el lead se reagendó en el CRM → la call vieja pierde sus pushes', () => {
  const vieja = cita();
  const { superseded } = escenario(reagenda(), [vieja]);
  assert.equal(superseded.length, 1);
  assert.equal(superseded[0].vieja.meeting_id, 'm-vieja');
  assert.equal(superseded[0].nueva.call_start, '2026-07-23 17:45:00');
  assert.ok(superseded[0].gapMin >= 60, 'el gap se reporta para poder auditar el log');
});

test('la nueva puede ser ANTES que la vieja (adelantar también es reagendar)', () => {
  const vieja = cita({ call_start: '2026-07-25 21:30:00' });
  const nueva = reagenda({ call_start: '2026-07-21 09:30:00' });
  const { superseded } = escenario(nueva, [vieja]);
  assert.equal(superseded.length, 1);
});

// ─── Lo que NO se puede cancelar ──────────────────────────────────────────────

test('dos citas creadas en la MISMA tanda de booking no son reagenda', () => {
  // Caso real: 19 pares en 21 días con createdate a segundos de distancia, y 5 de las "viejas"
  // terminaron COMPLETED. Cancelarlas habría matado calls que de verdad ocurrieron.
  const vieja = cita({ created_at: '2026-07-19T04:42:00Z' });
  const nueva = reagenda({ created_at: '2026-07-19T04:42:30Z' });
  const { superseded, skipped } = escenario(nueva, [vieja]);
  assert.equal(superseded.length, 0);
  assert.equal(skipped.mismaTanda, 1);
});

test(`el umbral es ${MIN_REBOOK_GAP_MIN} min: justo debajo no cancela, justo encima sí`, () => {
  const base = Date.parse('2026-07-19T04:42:00Z');
  const conGap = (min) =>
    escenario(reagenda({ created_at: new Date(base + min * 60000).toISOString() }), [
      cita({ created_at: new Date(base).toISOString() }),
    ]);
  assert.equal(conGap(MIN_REBOOK_GAP_MIN - 1).superseded.length, 0);
  assert.equal(conGap(MIN_REBOOK_GAP_MIN).superseded.length, 1);
});

test('la call vieja YA arrancó → es un rebook post-call, su push salió bien', () => {
  // 39 de 72 pares del backtest son de este tipo: no-show y se vuelve a agendar. No hay nada
  // que cancelar, el aviso de la primera call era correcto.
  const vieja = cita({ call_start: '2026-07-20 11:00:00' }); // una hora antes de NOW
  const { superseded, skipped } = escenario(reagenda(), [vieja]);
  assert.equal(superseded.length, 0);
  assert.equal(skipped.yaArranco, 1);
});

test('registrar a mano una call PASADA no le mata el push a la call futura', () => {
  // Un closer dejando constancia de una llamada de ayer crea un meeting nuevo con hora vieja.
  // Sin este guardarraíl, ese registro cancelaría la cita real de mañana.
  const vieja = cita({ call_start: '2026-07-22 16:30:00' });
  const nueva = reagenda({ call_start: '2026-07-19 16:00:00' }); // arranque en el pasado
  const { superseded, skipped } = escenario(nueva, [vieja]);
  assert.equal(superseded.length, 0);
  assert.equal(skipped.nuevaEnPasado, 1);
});

test('otro programa del mismo lead no es una movida, es otra conversación', () => {
  const vieja = cita({ program: 'developers' });
  const { superseded, skipped } = escenario(reagenda(), [vieja]);
  assert.equal(superseded.length, 0);
  assert.equal(skipped.otroPrograma, 1);
});

test('los registros duplicados de HubSpot al mismo minuto no se confunden con reagenda', () => {
  const nueva = reagenda();
  const dup = cita({ meeting_id: 'm-dup', call_start: nueva.call_start });
  const { superseded, skipped } = escenario(nueva, [dup]);
  assert.equal(superseded.length, 0);
  assert.equal(skipped.mismoMinuto, 1);
});

test('un lead sin otras citas no produce nada', () => {
  const { superseded } = escenario(reagenda(), []);
  assert.equal(superseded.length, 0);
});

// ─── Robustez ─────────────────────────────────────────────────────────────────

test('la MISMA call vieja duplicada en HubSpot se cancela UNA sola vez', () => {
  // El CRM guarda varios registros de una misma call (caso real: 3 al mismo minuto). La
  // cancelación es por closer+minuto, así que tiene que colapsar a una.
  const nueva = reagenda();
  const dups = ['a', 'b', 'c'].map((s) => cita({ meeting_id: `m-${s}` }));
  const { superseded } = escenario(nueva, dups);
  assert.equal(superseded.length, 1);
});

test('sin createdate no se decide nada (ni a favor ni en contra)', () => {
  const sinFecha = escenario(reagenda({ created_at: null }), [cita()]);
  assert.equal(sinFecha.superseded.length, 0);
  const viejaSinFecha = escenario(reagenda(), [cita({ created_at: '' })]);
  assert.equal(viejaSinFecha.superseded.length, 0);
});

test('entrada vacía no explota', () => {
  const { superseded, skipped } = pickRescheduledAway({});
  assert.equal(superseded.length, 0);
  assert.equal(skipped.mismaTanda, 0);
});

test('varias reagendas salen ordenadas por la hora de la call vieja', () => {
  const nuevas = [
    reagenda({ contact_id: 'c2', meeting_id: 'n2', call_start: '2026-07-24 10:00:00' }),
    reagenda({ contact_id: 'c1', meeting_id: 'n1', call_start: '2026-07-25 10:00:00' }),
  ];
  const { superseded } = pickRescheduledAway({
    nuevas,
    siblingsByContact: {
      c1: [nuevas[1], cita({ contact_id: 'c1', call_start: '2026-07-21 08:00:00' })],
      c2: [nuevas[0], cita({ contact_id: 'c2', meeting_id: 'v2', call_start: '2026-07-20 20:00:00' })],
    },
    nowMs: NOW,
  });
  assert.equal(superseded.length, 2);
  assert.equal(superseded[0].vieja.call_start, '2026-07-20 20:00:00');
});

test('callKey es la misma identidad que usan el poll y el reporte', () => {
  assert.equal(callKey('  Pablo.Lozano@30X.com ', '2026-07-22 16:30:45'), 'pablo.lozano@30x.com|2026-07-22 16:30');
});
