// test/calendly.outcome-scenarios.test.js
// Escenarios del registro de outcomes post-call (Push 4, §18.AB) vía el harness
// (mock API + store en memoria + spy WA + reloj inyectable). Cubre: agendado del
// Push 4, pregunta al vencer + creación del pendiente, cancelación → outcome auto,
// e insistencia (un recordatorio) → "sin registrar".

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';

import * as scheduler from '../src/scheduler/calendly.js';
import { __resetHealth } from '../src/calendly/health.js';
import { installHarness, makeEvent } from './helpers/calendly-harness.js';

const MIN = 60000;
const SALAZAR = 'sebastian.salazar@30x.com';
const SALAZAR_PHONE = '+573054312905';

beforeEach(() => {
  process.env.CALENDLY_DRY_RUN = 'false';
  // Salazar, el closer de fixture de este archivo, pasó a la conexión 'estadox' con la mudanza
  // del Calendly de EstadoX (2026-08-25). Su dry-run es INDEPENDIENTE del de 30x: sin esta línea
  // todos estos escenarios corren mudos y no se entrega nada.
  process.env.CALENDLY_DRY_RUN_ESTADOX = 'false';
  process.env.CALENDLY_REQUIRE_OPTIN = 'true';
  process.env.CALENDLY_PUSH3_LEAD_MIN = '25';
  process.env.CALENDLY_PUSH4_ENABLED = 'true';
  process.env.CALENDLY_CALL_DURATION_MIN = '30';
  process.env.CALENDLY_PUSH4_GRACE_MIN = '5';
  process.env.CALENDLY_OUTCOME_REMIND_MIN = '30';
  process.env.CALENDLY_OUTCOME_EXPIRE_MIN = '30';
  process.env.ADMIN_LID = '129446371655733@lid';
  __resetHealth();
  scheduler.__resetDeps();
});

test('poll agenda el Push 4 a start+35 con el programa de la cita', async () => {
  const now = Date.now();
  const events = [makeEvent({ uuid: 'p4', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
  const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: now });

  await scheduler.runCalendlyPoll();
  const p4 = h.store._rows.find((r) => r.push_n === 4);
  assert.ok(p4, 'se agendó el Push 4');
  assert.equal(p4.program, 'second_brain', 'guarda el programa para el reporte');
  // due = start (now+20) + 30 + 5 = now+55min.
  const expected = new Date(now + 55 * MIN).toISOString().slice(0, 16);
  assert.equal(`${p4.due_at.replace(' ', 'T')}Z`.slice(0, 16), expected);
});

test('al vencer el Push 4 pregunta el outcome y crea el pendiente', async () => {
  const now = Date.now();
  const events = [makeEvent({ uuid: 'p4', startInMin: 20, closerEmail: SALAZAR, prospectName: 'Ana Gómez', nowMs: now })];
  const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: now });

  await scheduler.runCalendlyPoll();
  h.clock.ms = now + 56 * MIN; // pasó el fin de la call + gracia
  await scheduler.runCalendlyDelivery();

  const p4 = h.store._rows.find((r) => r.push_n === 4);
  assert.equal(p4.status, 'sent');
  const ask = h.wa.sent.find((m) => /Registro de call/.test(m.text));
  assert.ok(ask, 'le preguntó el outcome al closer');
  assert.match(ask.text, /Ana Gómez/);
  assert.equal(h.store._outcomes.length, 1, 'creó el outcome pendiente');
  assert.equal(h.store._outcomes[0].status, 'pending');
  assert.equal(h.store._outcomes[0].program, 'second_brain');
});

test('cita cancelada → outcome AUTO (cancelado), sin molestar al closer', async () => {
  const now = Date.now();
  const events = [makeEvent({ uuid: 'pc', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
  const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: now });

  await scheduler.runCalendlyPoll();
  h.api.cancel('pc');
  h.clock.ms = now + 56 * MIN;
  await scheduler.runCalendlyDelivery();

  assert.ok(!h.wa.sent.some((m) => /Registro de call/.test(m.text)), 'no se le pregunta a una cancelada');
  assert.equal(h.store._outcomes.length, 1);
  assert.equal(h.store._outcomes[0].status, 'auto');
  assert.equal(h.store._outcomes[0].asistencia, 'cancelado');
});

test('insistencia v1: un recordatorio a los 30 min y luego "sin registrar"', async () => {
  const now = Date.now();
  const events = [makeEvent({ uuid: 'rem', startInMin: 20, closerEmail: SALAZAR, prospectName: 'Ana', nowMs: now })];
  const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: now });

  await scheduler.runCalendlyPoll();
  h.clock.ms = now + 56 * MIN;
  await scheduler.runCalendlyDelivery(); // crea el pendiente (asked_at = now+56)

  // Inmediatamente no hay nada que recordar.
  await scheduler.runOutcomeReminders();
  assert.equal(h.wa.sent.filter((m) => /Recordatorio/i.test(m.text)).length, 0);

  // +31 min → un recordatorio, marca reminded.
  h.clock.ms = now + 56 * MIN + 31 * MIN;
  await scheduler.runOutcomeReminders();
  assert.equal(h.wa.sent.filter((m) => /Recordatorio/i.test(m.text)).length, 1);
  assert.equal(h.store._outcomes[0].reminded, 1);

  // +otros ~31 min sin respuesta → queda 'no_answer' (sin registrar).
  h.clock.ms = now + 56 * MIN + 62 * MIN;
  await scheduler.runOutcomeReminders();
  assert.equal(h.store._outcomes[0].status, 'no_answer');
  // No se manda un segundo recordatorio (insistencia = una sola vez).
  assert.equal(h.wa.sent.filter((m) => /Recordatorio/i.test(m.text)).length, 1);
});

test('allowlist: solo se agenda el Push 4 para los closers permitidos', async () => {
  const now = Date.now();
  process.env.CALENDLY_PUSH4_CLOSERS = 'pablo.lozano@30x.com'; // solo Pablo
  const events = [
    makeEvent({ uuid: 'pablo', startInMin: 20, closerEmail: 'pablo.lozano@30x.com', nowMs: now }),
    makeEvent({ uuid: 'sala', startInMin: 20, closerEmail: SALAZAR, nowMs: now }),
  ];
  const h = installHarness(scheduler, {
    events,
    optins: ['+573046131437', SALAZAR_PHONE], // Pablo + Salazar
    nowMs: now,
  });
  await scheduler.runCalendlyPoll();
  const push4s = h.store._rows.filter((r) => r.push_n === 4);
  assert.equal(push4s.length, 1, 'solo un Push 4 (el de Pablo)');
  assert.equal(push4s[0].event_uuid, 'pablo');
  // Ambos sí reciben su Push 3 (el allowlist no toca el precall).
  assert.equal(h.store._rows.filter((r) => r.push_n === 3).length, 2);
  delete process.env.CALENDLY_PUSH4_CLOSERS;
});

test('no se pregunta el outcome si el closer no tiene opt-in (anti-ban)', async () => {
  const now = Date.now();
  const events = [makeEvent({ uuid: 'noopt', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
  const h = installHarness(scheduler, { events, optins: [], nowMs: now }); // sin opt-in

  await scheduler.runCalendlyPoll();
  h.clock.ms = now + 56 * MIN;
  await scheduler.runCalendlyDelivery();

  assert.ok(!h.wa.sent.some((m) => /Registro de call/.test(m.text)));
  // Sin envío real no se crea el pendiente (no tendría cómo responderlo).
  assert.equal(h.store._outcomes.length, 0);
  const p4 = h.store._rows.find((r) => r.push_n === 4);
  assert.equal(p4.status, 'skipped');
});

// ─── Auditoría 2026-08-26, hallazgo 07 ───────────────────────────────────────

// El dry-run era el modo "no envía nada" de una cuenta muda… salvo que SÍ escribía en
// `call_outcomes`. Esa fila abierta a nadie caduca sola como 'no_answer' a los ~60 min y
// entra al reporte como "el closer no registró la call". Una cuenta en dry-run ensuciaba
// las métricas de cumplimiento con calls que jamás se preguntaron.
test('DRY-RUN: el Push 4 no abre un pendiente que nadie va a poder responder', async () => {
  process.env.CALENDLY_DRY_RUN_ESTADOX = 'true';
  const now = Date.now();
  const events = [makeEvent({ uuid: 'p4dry', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
  const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: now });

  await scheduler.runCalendlyPoll();
  h.clock.ms = now + 56 * MIN;
  await scheduler.runCalendlyDelivery();

  const p4 = h.store._rows.find((r) => r.push_n === 4);
  assert.equal(p4.status, 'sent', 'el push SÍ se marca: es el ledger del job y sale antes del guard de obsolescencia');
  assert.equal(h.wa.sent.length, 0, 'dry-run no manda nada');
  assert.equal(h.store._outcomes.length, 0, 'y NO fabrica el outcome: nadie fue preguntado');
});

// El push quedaba 'sent' y RECIÉN después se insertaba el outcome. Si esa inserción fallaba
// (SQLITE_BUSY es normal: `agent` y `dash` escriben el mismo archivo), al closer ya se le
// había preguntado y su respuesta no tenía dónde caer — y el push, ya consumido, no volvía.
test('si el outcome no se puede guardar, el Push 4 NO queda consumido', async () => {
  const now = Date.now();
  const events = [makeEvent({ uuid: 'p4tx', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
  const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: now });

  await scheduler.runCalendlyPoll();

  // La transacción explota: ni outcome ni 'sent'.
  const real = h.store.marcarPush4Preguntado;
  let exploto = false;
  h.deps.marcarPush4Preguntado = () => {
    exploto = true;
    throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
  };

  h.clock.ms = now + 56 * MIN;
  await scheduler.runCalendlyDelivery();
  assert.ok(exploto, 'el escenario pasó por el camino transaccional');

  const p4 = h.store._rows.find((r) => r.push_n === 4);
  assert.notEqual(p4.status, 'sent', 'el push no se quema con la pregunta hecha al vacío');
  assert.equal(h.store._outcomes.length, 0);

  // Restaurada la DB, el ciclo siguiente lo entrega y abre el pendiente.
  h.deps.marcarPush4Preguntado = (...a) => real.call(h.store, ...a);
  await scheduler.runCalendlyDelivery();
  assert.equal(h.store._rows.find((r) => r.push_n === 4).status, 'sent');
  assert.equal(h.store._outcomes.length, 1, 'la respuesta del closer ya tiene dónde caer');
});
