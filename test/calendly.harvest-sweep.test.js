// test/calendly.harvest-sweep.test.js
// Barrido periódico de cosecha (§18.AH). El harvest de planNudge es UNA sola foto en el
// momento del Push 4: si el closer actualiza el deal en HubSpot DESPUÉS de esa foto, la
// fila ya cerró sola como 'no_answer' y nadie vuelve a mirar. Este job re-consulta HubSpot
// para esas filas abandonadas y recupera el outcome si el closer ya actualizó, sin volver
// a mandar el nudge por WhatsApp.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';

import * as scheduler from '../src/scheduler/calendly.js';
import { toSqliteUtc } from '../src/calendly/index.js';
import { __resetHealth } from '../src/calendly/health.js';
import { installHarness, makeEvent } from './helpers/calendly-harness.js';

const HOUR = 3600000;
const SALAZAR = 'sebastian.salazar@30x.com';
const SALAZAR_PHONE = '+573054312905';

beforeEach(() => {
  process.env.CALENDLY_DRY_RUN = 'false';
  process.env.HUBSPOT_AGENDA_HARVEST = 'true';
  delete process.env.HUBSPOT_NUDGE_ENABLED;
  delete process.env.CALENDLY_RESCHEDULE_ENABLED;
  delete process.env.HUBSPOT_PROGRAM_PIPELINES; // defaults: second_brain cubierto
  delete process.env.HUBSPOT_HARVEST_SWEEP_MAX_AGE_HOURS;
  __resetHealth();
  scheduler.__resetDeps();
});

// Simula una fila que ya cayó al nudge y expiró como 'no_answer' (el caso real: Sebas
// no respondió al nudge de WhatsApp, pero SÍ actualizó el deal en HubSpot más tarde).
function seedStaleOutcome(h, { id = 1, eventUuid, callStartMsAgo = 90 * 60000, status = 'no_answer', leadName = 'Jasiel Casas' } = {}) {
  h.store._outcomes.push({
    id,
    event_uuid: eventUuid,
    program: 'second_brain',
    closer_email: SALAZAR,
    closer_phone: SALAZAR_PHONE.replace(/\D/g, ''),
    closer_name: 'Sebastian Rodriguez',
    lead_name: leadName,
    lead_phone: '+573001112222',
    call_start: toSqliteUtc(new Date(h.clock.ms - callStartMsAgo)),
    asistencia: null,
    resultado: null,
    status,
    asked_at: h.clock.ms - callStartMsAgo,
    prompted_at: null,
    answered_at: null,
    reminded: 1,
    raw_reply: null,
    rescheduled_to: null,
    reschedule_uuid: null,
    reschedule_asked: 0,
  });
  return h.store._outcomes.find((o) => o.id === id);
}

test('recupera un show cosechado tarde: closer actualizó HubSpot después de que el nudge cerró como no_answer', async () => {
  const now = Date.now();
  const events = [makeEvent({ uuid: 'sw1', startInMin: -90, closerEmail: SALAZAR, prospectName: 'Jasiel Casas', nowMs: now })];
  const h = installHarness(scheduler, {
    events, optins: [SALAZAR_PHONE], nowMs: now,
    match: { covered: true, agendaStatus: 'COMPLETED', deal: { id: '55' } },
  });
  seedStaleOutcome(h, { eventUuid: 'sw1' });

  const n = await scheduler.runHarvestSweep();

  assert.equal(n, 1);
  const o = h.store._outcomes[0];
  assert.equal(o.asistencia, 'show');
  assert.equal(o.status, 'auto', 'se cierra como cosechado, no queda pending ni no_answer');
  assert.equal(h.wa.sent.length, 0, 'el barrido nunca manda WhatsApp — no se re-nudgea');
});

test('venta cerrada: show + deal en etapa Ganado → resultado=venta_cerrada también en el barrido', async () => {
  const now = Date.now();
  const events = [makeEvent({ uuid: 'sw2', startInMin: -90, closerEmail: SALAZAR, prospectName: 'Jasiel Casas', nowMs: now })];
  const h = installHarness(scheduler, {
    events, optins: [SALAZAR_PHONE], nowMs: now,
    match: { covered: true, agendaStatus: 'COMPLETED', won: true, deal: { id: '55' } },
  });
  seedStaleOutcome(h, { eventUuid: 'sw2' });

  await scheduler.runHarvestSweep();

  const o = h.store._outcomes[0];
  assert.equal(o.asistencia, 'show');
  assert.equal(o.resultado, 'venta_cerrada');
});

test('closer sigue sin actualizar (agenda_status todavía SCHEDULED) → se deja igual, sin re-mandar el nudge', async () => {
  const now = Date.now();
  const events = [makeEvent({ uuid: 'sw3', startInMin: -90, closerEmail: SALAZAR, prospectName: 'Jasiel Casas', nowMs: now })];
  const h = installHarness(scheduler, {
    events, optins: [SALAZAR_PHONE], nowMs: now,
    match: { covered: true, agendaStatus: 'SCHEDULED', deal: { id: '55' } },
  });
  seedStaleOutcome(h, { eventUuid: 'sw3' });

  const n = await scheduler.runHarvestSweep();

  assert.equal(n, 0, 'nada que recuperar todavía');
  const o = h.store._outcomes[0];
  assert.equal(o.asistencia, null, 'sigue sin registrar');
  assert.equal(o.status, 'no_answer', 'no se toca el status');
  assert.equal(h.wa.sent.length, 0, 'el barrido no re-nudgea por WhatsApp');
});

test('reagenda detectada tarde: cosecha "reagendado" y agenda la call nueva', async () => {
  process.env.CALENDLY_RESCHEDULE_ENABLED = 'true';
  const now = Date.now();
  const future = new Date(now + 3 * 24 * 60 * 60000).toISOString();
  const events = [makeEvent({ uuid: 'sw4', startInMin: -90, closerEmail: SALAZAR, prospectName: 'Jasiel Casas', nowMs: now })];
  const h = installHarness(scheduler, {
    events, optins: [SALAZAR_PHONE], nowMs: now,
    match: { covered: true, agendaStatus: 'RESCHEDULED', nextMeetingStart: future, deal: { id: '55' } },
  });
  seedStaleOutcome(h, { eventUuid: 'sw4' });

  const n = await scheduler.runHarvestSweep();

  assert.equal(n, 1);
  const o = h.store._outcomes[0];
  assert.equal(o.asistencia, 'reagendado');
  assert.equal(o.status, 'auto');
  const manual = h.store._rows.filter((r) => String(r.event_uuid).startsWith('manual:'));
  assert.ok(manual.some((r) => r.push_n === 4), 'agendó el Push 4 de la call nueva');
  assert.equal(h.wa.sent.length, 0);
});

test('respeta el tope de antigüedad: una fila más vieja que maxAgeHours no se vuelve a consultar', async () => {
  process.env.HUBSPOT_HARVEST_SWEEP_MAX_AGE_HOURS = '72';
  const now = Date.now();
  const events = [makeEvent({ uuid: 'sw5', startInMin: -90, closerEmail: SALAZAR, prospectName: 'Vieja', nowMs: now })];
  const h = installHarness(scheduler, {
    events, optins: [SALAZAR_PHONE], nowMs: now,
    match: { covered: true, agendaStatus: 'COMPLETED', deal: { id: '55' } },
  });
  // Call de hace 100 horas → por fuera del tope de 72h.
  seedStaleOutcome(h, { eventUuid: 'sw5', callStartMsAgo: 100 * HOUR });

  const n = await scheduler.runHarvestSweep();

  assert.equal(n, 0, 'fila fuera del tope → no se toca');
  assert.equal(h.matchCalls.length, 0, 'ni siquiera se consultó HubSpot para esa fila');
  assert.equal(h.store._outcomes[0].asistencia, null);
});

test('sin HubSpot configurado → el barrido no hace nada (no revienta)', async () => {
  const now = Date.now();
  const h = installHarness(scheduler, { events: [], optins: [SALAZAR_PHONE], nowMs: now }); // sin `match` → hubspotEnabled() false
  seedStaleOutcome(h, { eventUuid: 'sw6' });

  const n = await scheduler.runHarvestSweep();

  assert.equal(n, 0);
  assert.equal(h.store._outcomes[0].asistencia, null);
});
