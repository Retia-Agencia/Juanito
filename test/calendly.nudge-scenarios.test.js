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
  delete process.env.HUBSPOT_AGENDA_HARVEST;
  delete process.env.CALENDLY_RESCHEDULE_ENABLED;
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

// ─── Cosecha por agenda_status (§18.AG) ───────────────────────────────────────

test('harvest: agenda_status COMPLETED → outcome "show" cosechado, sin preguntar', async () => {
  process.env.HUBSPOT_AGENDA_HARVEST = 'true';
  const now = Date.now();
  const events = [makeEvent({ uuid: 'h1', startInMin: 20, closerEmail: SALAZAR, prospectName: 'Ana Gómez', nowMs: now })];
  const h = installHarness(scheduler, {
    events, optins: [SALAZAR_PHONE], nowMs: now,
    match: { covered: true, agendaStatus: 'COMPLETED', deal: { id: '55' } },
  });
  await pollThenDeliver(h, now);

  assert.equal(push4Msgs(h.wa).length, 0, 'no se mandó nada (cosecha silenciosa)');
  const o = h.store._outcomes[0];
  assert.equal(o.asistencia, 'show');
  assert.equal(o.status, 'auto', 'registrado como automático, no pendiente');
  assert.equal(h.store._rows.find((r) => r.push_n === 4).status, 'sent');
});

test('harvest: COMPLETED + deal en etapa Ganado → cosecha también resultado="venta_cerrada"', async () => {
  process.env.HUBSPOT_AGENDA_HARVEST = 'true';
  const now = Date.now();
  const events = [makeEvent({ uuid: 'h1w', startInMin: 20, closerEmail: SALAZAR, prospectName: 'Ana Gómez', nowMs: now })];
  const h = installHarness(scheduler, {
    events, optins: [SALAZAR_PHONE], nowMs: now,
    match: { covered: true, agendaStatus: 'COMPLETED', won: true, deal: { id: '55' } },
  });
  await pollThenDeliver(h, now);

  const o = h.store._outcomes[0];
  assert.equal(o.asistencia, 'show');
  assert.equal(o.resultado, 'venta_cerrada', 'la venta se cosecha junto con la asistencia, sin preguntar');
});

test('harvest: COMPLETED sin el deal en Ganado → resultado null (no se inventa una venta)', async () => {
  process.env.HUBSPOT_AGENDA_HARVEST = 'true';
  const now = Date.now();
  const events = [makeEvent({ uuid: 'h1n', startInMin: 20, closerEmail: SALAZAR, prospectName: 'Ana Gómez', nowMs: now })];
  const h = installHarness(scheduler, {
    events, optins: [SALAZAR_PHONE], nowMs: now,
    match: { covered: true, agendaStatus: 'COMPLETED', won: false, deal: { id: '55' } },
  });
  await pollThenDeliver(h, now);

  assert.equal(h.store._outcomes[0].resultado, null);
});

test('harvest: NO_SHOW con deal en Ganado igual → resultado null (solo "show" cosecha venta)', async () => {
  process.env.HUBSPOT_AGENDA_HARVEST = 'true';
  const now = Date.now();
  const events = [makeEvent({ uuid: 'h2w', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
  const h = installHarness(scheduler, {
    events, optins: [SALAZAR_PHONE], nowMs: now,
    match: { covered: true, agendaStatus: 'NO_SHOW', won: true, deal: { id: '7' } },
  });
  await pollThenDeliver(h, now);

  assert.equal(h.store._outcomes[0].asistencia, 'no_show');
  assert.equal(h.store._outcomes[0].resultado, null, 'un no-show no es venta aunque el deal ya diga Ganado');
});

test('harvest: NO_SHOW → outcome "no_show" cosechado (lo que la etapa no daba)', async () => {
  process.env.HUBSPOT_AGENDA_HARVEST = 'true';
  const now = Date.now();
  const events = [makeEvent({ uuid: 'h2', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
  const h = installHarness(scheduler, {
    events, optins: [SALAZAR_PHONE], nowMs: now,
    match: { covered: true, agendaStatus: 'NO_SHOW', deal: { id: '7' } },
  });
  await pollThenDeliver(h, now);

  assert.equal(push4Msgs(h.wa).length, 0);
  assert.equal(h.store._outcomes[0].asistencia, 'no_show');
  assert.equal(h.store._outcomes[0].status, 'auto');
});

test('harvest: SCHEDULED vencida sin cita futura → nudge con link (único caso que molesta)', async () => {
  process.env.HUBSPOT_AGENDA_HARVEST = 'true';
  const now = Date.now();
  const events = [makeEvent({ uuid: 'h3', startInMin: 20, closerEmail: SALAZAR, prospectName: 'Ana Gómez', nowMs: now })];
  const h = installHarness(scheduler, {
    events, optins: [SALAZAR_PHONE], nowMs: now,
    match: { covered: true, agendaStatus: 'SCHEDULED', deal: { id: '55' } },
  });
  await pollThenDeliver(h, now);

  const msg = h.wa.sent.at(-1).text;
  assert.match(msg, /Agendado/, 'es el nudge');
  assert.match(msg, /deal\/55/, 'con deep-link al deal');
  assert.equal(h.store._outcomes[0].reminded, 1, 'pendiente activo con reminded=1');
});

test('harvest: SCHEDULED con cita FUTURA → silencio (reagenda no marcada / segunda call)', async () => {
  process.env.HUBSPOT_AGENDA_HARVEST = 'true';
  const now = Date.now();
  const events = [makeEvent({ uuid: 'h4', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
  const future = new Date(now + 3 * 24 * 60 * MIN).toISOString();
  const h = installHarness(scheduler, {
    events, optins: [SALAZAR_PHONE], nowMs: now,
    match: { covered: true, agendaStatus: 'SCHEDULED', nextMeetingStart: future, deal: { id: '55' } },
  });
  await pollThenDeliver(h, now);

  assert.equal(push4Msgs(h.wa).length, 0, 'no molesta: hay cita futura');
  assert.equal(h.store._outcomes.length, 0, 'ni pendiente');
  assert.equal(h.store._rows.find((r) => r.push_n === 4).status, 'sent');
});

test('harvest: RESCHEDULED → cosecha "reagendado" + agenda la call nueva desde next_meeting', async () => {
  process.env.HUBSPOT_AGENDA_HARVEST = 'true';
  process.env.CALENDLY_RESCHEDULE_ENABLED = 'true';
  const now = Date.now();
  const events = [makeEvent({ uuid: 'h5', startInMin: 20, closerEmail: SALAZAR, prospectName: 'Ana Gómez', nowMs: now })];
  const future = new Date(now + 3 * 24 * 60 * MIN).toISOString();
  const h = installHarness(scheduler, {
    events, optins: [SALAZAR_PHONE], nowMs: now,
    match: { covered: true, agendaStatus: 'RESCHEDULED', nextMeetingStart: future, deal: { id: '55' } },
  });
  await pollThenDeliver(h, now);

  assert.equal(push4Msgs(h.wa).length, 0, 'la reagenda se cosecha en silencio');
  const o = h.store._outcomes[0];
  assert.equal(o.asistencia, 'reagendado');
  assert.equal(o.status, 'auto');
  // Se agendó la call nueva con uuid sintético (mismo mecanismo que la reagenda manual).
  const manual = h.store._rows.filter((r) => String(r.event_uuid).startsWith('manual:'));
  assert.ok(manual.some((r) => r.push_n === 4), 'agendó el Push 4 de la call nueva');
});

test('harvest OFF por default → agenda_status ignorado, Push 4 clásico (regresión)', async () => {
  // Ni NUDGE ni HARVEST → no se toca HubSpot para el outcome.
  const now = Date.now();
  const events = [makeEvent({ uuid: 'h6', startInMin: 20, closerEmail: SALAZAR, prospectName: 'Ana Gómez', nowMs: now })];
  const h = installHarness(scheduler, {
    events, optins: [SALAZAR_PHONE], nowMs: now,
    match: { covered: true, agendaStatus: 'COMPLETED', deal: { id: '55' } },
  });
  await pollThenDeliver(h, now);

  assert.match(h.wa.sent.at(-1).text, /¿Cómo te fue/, 'sin flags → pregunta clásica');
  assert.equal(h.store._outcomes[0].status, 'pending');
});

// ─── Origen de la call: de dónde sale el email del lead (§18.AO) ──────────────
// Bug 2026-07-27: planNudge le pedía el email a Calendly SIEMPRE, armando la URL con el
// event_uuid. Para una cita que solo vive en HubSpot ese uuid es 'hubspot:<meetingId>', así que
// Calendly fallaba, el email quedaba null y el plan caía a Push 4 CLÁSICO. Medido en producción:
// de las calls de origen Calendly, 121 de 148 outcomes se cosecharon solos; de las de origen
// HubSpot, 0 de 3 — las tres le preguntaron al closer, que es justo lo que la cosecha evita.

// Mete a mano un Push 4 ya vencido, sin pasar por el poll (la call no existe en Calendly).
function seedPush4(h, { uuid, program = 'second_brain', closerEmail = SALAZAR, closerPhone = SALAZAR_PHONE }) {
  const callStart = new Date(h.clock.ms - 40 * MIN).toISOString().slice(0, 19).replace('T', ' ');
  h.store.scheduleCalendlyPush({
    event_uuid: uuid, push_n: 4, program,
    closer_email: closerEmail, closer_phone: closerPhone,
    prospect_name: 'Ana Gómez', prospect_phone: '+573004445555',
    call_start: callStart,
    due_at: new Date(h.clock.ms - 5 * MIN).toISOString().slice(0, 19).replace('T', ' '),
    message: 'push4 clásico',
  });
}

test('call solo-HubSpot: el email del lead sale del contacto del meeting, y se cosecha sin preguntar', async () => {
  process.env.HUBSPOT_AGENDA_HARVEST = 'true';
  const now = Date.now();
  const h = installHarness(scheduler, {
    events: [], optins: [SALAZAR_PHONE], nowMs: now,
    match: ({ email }) =>
      email === 'lead@hubspot.test'
        ? { covered: true, agendaStatus: 'COMPLETED', deal: { id: '77' } }
        : { covered: false },
  });
  // El contacto asociado al meeting es la ÚNICA fuente del email para estas calls.
  const pedidos = [];
  h.deps.getMeetingContact = async (id) => {
    pedidos.push(id);
    return { id: 'c1', name: 'Ana Gómez', email: 'lead@hubspot.test', phone: '+573004445555' };
  };
  scheduler.__setDeps(h.deps);

  seedPush4(h, { uuid: 'hubspot:113635096174' });
  await scheduler.runCalendlyDelivery();

  assert.deepEqual(pedidos, ['113635096174'], 'se le pidió el contacto a HubSpot con el meetingId pelado');
  assert.equal(h.matchCalls[0]?.email, 'lead@hubspot.test', 'el deal se buscó con el email del contacto');
  assert.equal(push4Msgs(h.wa).length, 0, 'NO se le pregunta al closer: la cosecha ya sabe');
  assert.equal(h.store._outcomes[0].asistencia, 'show');
  assert.equal(h.store._outcomes[0].status, 'auto');
});

test('call solo-HubSpot sin contacto asociado → Push 4 clásico (red de seguridad intacta)', async () => {
  process.env.HUBSPOT_AGENDA_HARVEST = 'true';
  const now = Date.now();
  const h = installHarness(scheduler, {
    events: [], optins: [SALAZAR_PHONE], nowMs: now,
    match: { covered: true, agendaStatus: 'COMPLETED', deal: { id: '77' } },
  });
  h.deps.getMeetingContact = async () => null; // el meeting no tiene contacto
  scheduler.__setDeps(h.deps);

  seedPush4(h, { uuid: 'hubspot:999' });
  await scheduler.runCalendlyDelivery();

  assert.equal(push4Msgs(h.wa).length, 1, 'sin email no se puede cosechar → se pregunta, como antes');
  assert.equal(h.matchCalls.length, 0, 'ni se llama al matcher sin email');
});

test('call de Calendly: sigue sacando el email del invitee (regresión)', async () => {
  process.env.HUBSPOT_AGENDA_HARVEST = 'true';
  const now = Date.now();
  const events = [makeEvent({ uuid: 'cal-1', startInMin: 20, closerEmail: SALAZAR, prospectName: 'Ana Gómez', nowMs: now })];
  const h = installHarness(scheduler, {
    events, optins: [SALAZAR_PHONE], nowMs: now,
    match: { covered: true, agendaStatus: 'COMPLETED', deal: { id: '55' } },
  });
  let pidioHubspot = false;
  h.deps.getMeetingContact = async () => { pidioHubspot = true; return null; };
  scheduler.__setDeps(h.deps);

  await pollThenDeliver(h, now);

  assert.equal(pidioHubspot, false, 'una call de Calendly no debe ir a buscar contactos a HubSpot');
  assert.equal(push4Msgs(h.wa).length, 0);
  assert.equal(h.store._outcomes[0].status, 'auto');
});
