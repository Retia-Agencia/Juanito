// test/calendly.nudge-scenarios.test.js
// Escenarios del modelo nudge (§18.AF) en la entrega del Push 4, vía el harness
// (mock de matchCallToDeal + store en memoria + spy WA). Verifica que:
//   - con el flag OFF, todo sigue en Push 4 clásico (regresión)
//   - deal estancado → nudge con link; el pendiente queda activo (captura de reagenda) y
//     con reminded=1 (suprime el recordatorio clásico → no doble-pregunta)
//   - deal resuelto → silencio (ni mensaje ni pendiente)
//   - lead sin contacto → nudge de creación
//   - programa NO cubierto → Push 4 clásico aunque el flag esté ON (ni se llama al matcher)

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';

import * as scheduler from '../src/scheduler/calendly.js';
import { __resetHealth } from '../src/calendly/health.js';
import { installHarness, makeEvent } from './helpers/calendly-harness.js';

const MIN = 60000;
const SALAZAR = 'sebastian.salazar@30x.com';
const SALAZAR_PHONE = '+573054312905';
const DEVELOPERS_ET = 'https://api.calendly.com/event_types/dff3e48a-4859-417a-98fb-822048aef5d9';

beforeEach(() => {
  process.env.CALENDLY_DRY_RUN = 'false';
  process.env.CALENDLY_REQUIRE_OPTIN = 'true';
  process.env.CALENDLY_PUSH4_ENABLED = 'true';
  process.env.CALENDLY_CALL_DURATION_MIN = '30';
  process.env.CALENDLY_PUSH4_GRACE_MIN = '5';
  delete process.env.HUBSPOT_NUDGE_ENABLED;
  delete process.env.HUBSPOT_PROGRAM_PIPELINES; // usa los defaults (second_brain cubierto)
  __resetHealth();
  scheduler.__resetDeps();
});

// Agenda el Push 4 y avanza el reloj hasta después de la call + gracia.
async function pollThenDeliver(h, now, { startInMin = 20 } = {}) {
  await scheduler.runCalendlyPoll();
  h.clock.ms = now + (startInMin + 36) * MIN; // pasó fin de call (start+30) + gracia (5)
  await scheduler.runCalendlyDelivery();
}
const push4Msgs = (wa) => wa.sent.filter((m) => /Cómo te fue|Agendado|no lo encuentro|sin deal/i.test(m.text));

test('flag OFF → Push 4 clásico aunque haya match (regresión)', async () => {
  const now = Date.now();
  const events = [makeEvent({ uuid: 'n1', startInMin: 20, closerEmail: SALAZAR, prospectName: 'Ana Gómez', nowMs: now })];
  const h = installHarness(scheduler, {
    events, optins: [SALAZAR_PHONE], nowMs: now,
    match: { covered: true, status: 'stale', deal: { id: '55' } },
  });
  // HUBSPOT_NUDGE_ENABLED sin setear → off
  await pollThenDeliver(h, now);

  assert.match(h.wa.sent.at(-1).text, /¿Cómo te fue/, 'mandó la pregunta clásica');
  const o = h.store._outcomes[0];
  assert.equal(o.status, 'pending');
  assert.equal(o.reminded, 0, 'clásico → el recordatorio sigue habilitado');
});

test('deal estancado (Agendado) → nudge con link + pendiente activo con reminded=1', async () => {
  process.env.HUBSPOT_NUDGE_ENABLED = 'true';
  const now = Date.now();
  const events = [makeEvent({ uuid: 'n2', startInMin: 20, closerEmail: SALAZAR, prospectName: 'Ana Gómez', nowMs: now })];
  const h = installHarness(scheduler, {
    events, optins: [SALAZAR_PHONE], nowMs: now,
    match: { covered: true, status: 'stale', deal: { id: '55' } },
  });
  await pollThenDeliver(h, now);

  const msg = h.wa.sent.at(-1).text;
  assert.match(msg, /Agendado/, 'es el nudge, no la pregunta');
  assert.match(msg, /deal\/55/, 'trae el deep-link al deal');
  assert.doesNotMatch(msg, /¿Cómo te fue/, 'no es la pregunta clásica');

  const o = h.store._outcomes[0];
  assert.equal(o.status, 'pending', 'pendiente activo → una respuesta de reagenda se captura');
  assert.equal(o.reminded, 1, 'reminded=1 → suprime el recordatorio clásico');
  // El pendiente es matcheable por una respuesta del closer (Q1: reagenda sobre el nudge).
  assert.ok(h.store.getActiveOutcomeForCloser(SALAZAR_PHONE), 'getActiveOutcomeForCloser lo encuentra');
  // Y el cron de recordatorio NO lo levanta.
  h.clock.ms += 40 * MIN;
  assert.equal(h.store.getDueOutcomeReminders(30).length, 0, 'ningún recordatorio pendiente');
});

test('deal resuelto → silencio: ni mensaje ni pendiente', async () => {
  process.env.HUBSPOT_NUDGE_ENABLED = 'true';
  const now = Date.now();
  const events = [makeEvent({ uuid: 'n3', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
  const h = installHarness(scheduler, {
    events, optins: [SALAZAR_PHONE], nowMs: now,
    match: { covered: true, status: 'resolved', deal: { id: '9' } },
  });
  await pollThenDeliver(h, now);

  assert.equal(push4Msgs(h.wa).length, 0, 'no se mandó nada (ni pregunta ni nudge)');
  assert.equal(h.store._outcomes.length, 0, 'no se creó pendiente');
  const p4 = h.store._rows.find((r) => r.push_n === 4);
  assert.equal(p4.status, 'sent', 'el push queda cerrado');
});

test('lead sin contacto en HubSpot → nudge de creación', async () => {
  process.env.HUBSPOT_NUDGE_ENABLED = 'true';
  const now = Date.now();
  const events = [makeEvent({ uuid: 'n4', startInMin: 20, closerEmail: SALAZAR, prospectName: 'Ana Gómez', nowMs: now })];
  const h = installHarness(scheduler, {
    events, optins: [SALAZAR_PHONE], nowMs: now,
    match: { covered: true, reason: 'no_contact' },
  });
  await pollThenDeliver(h, now);

  assert.match(h.wa.sent.at(-1).text, /no lo encuentro/i, 'pide crear el deal en HubSpot');
  assert.equal(h.store._outcomes[0].reminded, 1);
});

test('programa NO cubierto (developers) → clásico aunque el flag esté ON; ni se llama al matcher', async () => {
  process.env.HUBSPOT_NUDGE_ENABLED = 'true';
  const now = Date.now();
  const events = [
    makeEvent({ uuid: 'n5', startInMin: 20, closerEmail: SALAZAR, eventType: DEVELOPERS_ET, prospectName: 'Ana Gómez', nowMs: now }),
  ];
  const h = installHarness(scheduler, {
    events, optins: [SALAZAR_PHONE], nowMs: now,
    match: { covered: true, status: 'stale', deal: { id: '55' } },
  });
  await pollThenDeliver(h, now);

  assert.match(h.wa.sent.at(-1).text, /¿Cómo te fue/, 'developers → Push 4 clásico');
  assert.equal(h.store._outcomes[0].reminded, 0);
  assert.equal(h.matchCalls.length, 0, 'no se consultó HubSpot para un programa no cubierto');
});
