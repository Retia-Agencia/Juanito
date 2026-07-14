// test/calendly.reschedule-logic.test.js
// Tests PUROS de las decisiones de una reagenda (§18.AC): uuids sintéticos, dedup contra
// Calendly, y el tercer paso de la máquina de estados del Push 4. Sin DB → Windows.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { rootUuidOf, chainDepthOf, nextManualUuid, isManualUuid, isSameLead, pickSupersededPushes } =
  await import('../src/calendly/reschedule-logic.js');
const { decideOutcomeReply } = await import('../src/calendly/outcome-logic.js');

const TZ = 'America/Bogota';
const NOW = Date.parse('2026-07-14T14:40:00Z'); // mar 14 jul, 9:40am Bogotá

// ─── uuids sintéticos ─────────────────────────────────────────────────────────

test('la cadena de reagendas no anida prefijos: solo sube el contador', () => {
  const real = 'abc-123';
  const u1 = nextManualUuid(real);
  assert.equal(u1, 'manual:abc-123:1');
  assert.equal(chainDepthOf(u1), 1);
  assert.equal(rootUuidOf(u1), real);

  const u2 = nextManualUuid(u1);
  assert.equal(u2, 'manual:abc-123:2'); // NO 'manual:manual:abc-123:1:1'
  assert.equal(chainDepthOf(u2), 2);
  assert.equal(rootUuidOf(u2), real);

  assert.equal(isManualUuid(u2), true);
  assert.equal(isManualUuid(real), false); // → el poll sí consulta la API para este
});

// ─── Dedup: la reagenda volvió a entrar por Calendly ──────────────────────────

const manualPushes = [
  {
    event_uuid: 'manual:abc:1', push_n: 4, closer_phone: '573001112233',
    prospect_name: 'Ana Pérez', prospect_phone: '573109998877',
  },
  {
    event_uuid: 'manual:xyz:1', push_n: 4, closer_phone: '573001112233',
    prospect_name: 'Luis Gómez', prospect_phone: null,
  },
];

test('mismo closer + mismo lead (por teléfono) → el evento real supersede al sintético', () => {
  const hits = pickSupersededPushes(manualPushes, {
    closerPhone: '+57 300 111 2233',
    leadPhone: '57 310 999 8877',
    leadName: 'Ana Pérez Rodríguez', // el nombre cambió, el teléfono manda
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].event_uuid, 'manual:abc:1');
});

test('sin teléfono (Calendly lo deja null en reagendadas) el match cae al nombre', () => {
  const hits = pickSupersededPushes(manualPushes, {
    closerPhone: '573001112233',
    leadPhone: null,
    leadName: 'luis gomez', // sin tildes, minúsculas
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].event_uuid, 'manual:xyz:1');
});

test('otro closer o otro lead NO supersede (no se pisan reagendas ajenas)', () => {
  assert.equal(
    pickSupersededPushes(manualPushes, {
      closerPhone: '573009998888', // otro closer
      leadPhone: '573109998877',
      leadName: 'Ana Pérez',
    }).length,
    0
  );
  assert.equal(
    pickSupersededPushes(manualPushes, {
      closerPhone: '573001112233',
      leadPhone: '573101010101', // otro lead
      leadName: 'Otro Prospecto',
    }).length,
    0
  );
});

test('teléfonos distintos NO caen al nombre (dos leads pueden llamarse igual)', () => {
  assert.equal(
    isSameLead({ phone: '573109998877', name: 'Ana Pérez' }, { phone: '573101010101', name: 'Ana Pérez' }),
    false
  );
});

// ─── Tercer paso de la máquina de estados ─────────────────────────────────────

const awaitingDate = { id: 1, status: 'awaiting_date', asistencia: 'reagendado' };

test('el Push 4 con "3" pide la FECHA (antes cerraba y la call nueva se perdía)', () => {
  const d = decideOutcomeReply({ id: 1, status: 'pending', asistencia: null }, '3');
  assert.equal(d.kind, 'asistencia');
  assert.equal(d.asistencia, 'reagendado');
  assert.equal(d.followup, 'fecha');
});

test('en awaiting_date, la fecha se parsea y se agenda la call', () => {
  const d = decideOutcomeReply(awaitingDate, 'hoy 3pm', { nowMs: NOW, tz: TZ });
  assert.equal(d.kind, 'reschedule');
  assert.equal(d.startUtc.toISOString(), '2026-07-14T20:00:00.000Z');
});

test('en awaiting_date, "aún no sé" deja la reagenda abierta para repreguntar mañana', () => {
  const d = decideOutcomeReply(awaitingDate, 'aún no sabemos', { nowMs: NOW, tz: TZ });
  assert.equal(d.kind, 'reschedule_unknown');
});

test('en awaiting_date, una fecha pasada se repregunta con su motivo', () => {
  const d = decideOutcomeReply(awaitingDate, 'hoy 8am', { nowMs: NOW, tz: TZ });
  assert.equal(d.kind, 'reschedule_reprompt');
  assert.equal(d.reason, 'past');
});

test('el regex aguanta el español suelto del closer', () => {
  const d = decideOutcomeReply(awaitingDate, 'pal viernes tipo 3 y media', { nowMs: NOW, tz: TZ });
  assert.equal(d.kind, 'reschedule');
  assert.equal(d.startUtc.toISOString(), '2026-07-17T20:30:00.000Z'); // vie 17, 3:30pm Bogotá
});

test('lo que el regex no saca sale sin motivo → ahí entra el fallback de IA', () => {
  // Sin hora numérica no hay nada que agendar: esto lo tiene que resolver Claude.
  const d = decideOutcomeReply(awaitingDate, 'el otro martes a primera hora', {
    nowMs: NOW,
    tz: TZ,
  });
  assert.equal(d.kind, 'reschedule_reprompt');
  assert.equal(d.reason, undefined); // sin motivo → outcome-capture intenta con Claude
});

test('show/no_show siguen igual que siempre (no se rompió el flujo viejo)', () => {
  const show = decideOutcomeReply({ status: 'pending', asistencia: null }, '1');
  assert.equal(show.followup, 'resultado');
  const noShow = decideOutcomeReply({ status: 'pending', asistencia: null }, 'no llegó');
  assert.equal(noShow.asistencia, 'no_show');
  assert.equal(noShow.followup, 'confirm');
  const resultado = decideOutcomeReply({ status: 'pending', asistencia: 'show' }, 'cerró');
  assert.equal(resultado.kind, 'resultado');
  assert.equal(resultado.resultado, 'venta_cerrada');
});
