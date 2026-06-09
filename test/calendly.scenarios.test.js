// test/calendly.scenarios.test.js
// Escenarios de integración de los jobs precall, vía el harness (mock API + store
// en memoria + spy de WhatsApp + reloj inyectable). Reproducen de forma
// determinista los casos que el dry-run en vivo NO puede forzar.
//
// Cubre: catch-up de reservas tardías (4b), reagenda tras envío (#2), doble envío
// por concurrencia (#1), cancelación/reagenda en la entrega, opt-in (anti-ban),
// alertas a admin (5) y los digests Push 1/2.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';

import * as scheduler from '../src/scheduler/calendly.js';
import { __resetHealth, getHealth } from '../src/calendly/health.js';
import { installHarness, makeEvent } from './helpers/calendly-harness.js';

const MIN = 60000;
const SALAZAR = 'sebastian.salazar@30x.com';
const SALAZAR_PHONE = '+573054312905';

// Entorno por defecto de los tests: envío REAL al spy (no dry-run) y opt-in exigido.
beforeEach(() => {
  process.env.CALENDLY_DRY_RUN = 'false';
  process.env.CALENDLY_REQUIRE_OPTIN = 'true';
  process.env.CALENDLY_PUSH3_LEAD_MIN = '25';
  process.env.ADMIN_LID = '129446371655733@lid';
  __resetHealth();
  scheduler.__resetDeps();
});

// ─── Decisión 4b: catch-up de reservas tardías ────────────────────────────────

test('catch-up: llamada en 20 min (todos los triggers pasaron) → Push 3 inmediato y se entrega', async () => {
  const now = Date.now();
  const events = [makeEvent({ uuid: 'late', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
  const { store, wa } = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: now });

  await scheduler.runCalendlyPoll();
  // El poll agendó el push con due = ahora (inmediato).
  assert.equal(store._rows.length, 1, 'debió agendar 1 push (antes del fix: 0)');
  assert.equal(store._rows[0].status, 'scheduled');

  await scheduler.runCalendlyDelivery();
  assert.equal(wa.sent.length, 1, 'el Push 3 inmediato debe entregarse');
  assert.match(wa.sent[0].text, /Push 3/);
  assert.equal(store._rows[0].status, 'sent');
});

test('catch-up: llamada que ya pasó → no se agenda nada', async () => {
  const now = Date.now();
  const events = [makeEvent({ uuid: 'past', startInMin: -10, closerEmail: SALAZAR, nowMs: now })];
  const { store } = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: now });
  await scheduler.runCalendlyPoll();
  assert.equal(store._rows.length, 0);
});

test('normal: llamada en 2h → Push 3 NO se entrega todavía (due futuro)', async () => {
  const now = Date.now();
  const events = [makeEvent({ uuid: 'fut', startInMin: 120, closerEmail: SALAZAR, nowMs: now })];
  const { store, wa } = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: now });
  await scheduler.runCalendlyPoll();
  assert.equal(store._rows.length, 1);
  await scheduler.runCalendlyDelivery();
  assert.equal(wa.sent.length, 0, 'aún no vence');
});

// ─── Bug #2: reagenda después de que el Push 3 ya se envió ─────────────────────

test('bug #2: reagenda tras envío → se re-arma y se entrega a la nueva hora', async () => {
  const now = Date.now();
  const events = [makeEvent({ uuid: 'resched', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
  const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: now });

  // 1) Se agenda (catch-up) y se entrega.
  await scheduler.runCalendlyPoll();
  await scheduler.runCalendlyDelivery();
  assert.equal(h.wa.sent.length, 1);
  assert.equal(h.store._rows[0].status, 'sent');

  // 2) El prospecto reagenda a +90 min. Avanza el reloj 30 min y vuelve a pollear.
  h.api.reschedule('resched', new Date(now + 90 * MIN).toISOString());
  h.clock.ms = now + 30 * MIN;
  await scheduler.runCalendlyPoll();
  assert.equal(h.store._rows[0].status, 'scheduled', 're-armado tras la reagenda (antes del fix: quedaba sent)');

  // 3) Llega la nueva hora del push → se entrega de nuevo.
  h.clock.ms = now + 90 * MIN - 25 * MIN + MIN;
  await scheduler.runCalendlyDelivery();
  assert.equal(h.wa.sent.length, 2, 'el closer recibe recordatorio de la NUEVA hora');
});

// ─── Entrega: re-validación de cancelación/reagenda ───────────────────────────

test('cancelación antes de entregar → se omite, no se envía', async () => {
  const now = Date.now();
  const events = [makeEvent({ uuid: 'cancel', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
  const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: now });
  await scheduler.runCalendlyPoll();
  h.api.cancel('cancel');
  await scheduler.runCalendlyDelivery();
  assert.equal(h.wa.sent.length, 0);
  assert.equal(h.store._rows[0].status, 'skipped');
});

test('reagenda detectada en la entrega → se omite (el poll agendará la nueva hora)', async () => {
  const now = Date.now();
  const events = [makeEvent({ uuid: 'move', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
  const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: now });
  await scheduler.runCalendlyPoll();
  // Cambia la hora pero AÚN no re-polleamos: la entrega ve el mismatch.
  h.api.reschedule('move', new Date(now + 200 * MIN).toISOString());
  await scheduler.runCalendlyDelivery();
  assert.equal(h.wa.sent.length, 0);
  assert.equal(h.store._rows[0].status, 'skipped');
});

// ─── Bug #1: doble envío por entregas concurrentes ────────────────────────────

test('bug #1: dos entregas concurrentes → el Push 3 se envía UNA sola vez', async () => {
  const now = Date.now();
  const events = [makeEvent({ uuid: 'dup', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
  const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: now });
  await scheduler.runCalendlyPoll();
  await Promise.all([scheduler.runCalendlyDelivery(), scheduler.runCalendlyDelivery()]);
  assert.equal(h.wa.sent.length, 1, 'sin doble envío');
});

// ─── Anti-ban: opt-in ─────────────────────────────────────────────────────────

test('anti-ban: closer sin opt-in → no se envía, se marca skipped', async () => {
  const now = Date.now();
  const events = [makeEvent({ uuid: 'noopt', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
  const h = installHarness(scheduler, { events, optins: [], nowMs: now }); // sin opt-ins
  await scheduler.runCalendlyPoll();
  await scheduler.runCalendlyDelivery();
  assert.equal(h.wa.sent.length, 0);
  assert.equal(h.store._rows[0].status, 'skipped');
});

test('anti-ban: la entrega va al contact_jid del opt-in (hilo real), no al número canónico', async () => {
  // Cierra el residual: el closer escribió desde un @lid (no su número de closers.js);
  // el push debe ir a ESE hilo, nunca en frío al número de trabajo que jamás escribió.
  const now = Date.now();
  const JID = '20671711162446@lid';
  const events = [makeEvent({ uuid: 'jid', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
  const h = installHarness(scheduler, {
    events,
    optins: [{ phone: SALAZAR_PHONE, contactJid: JID }],
    nowMs: now,
  });
  await scheduler.runCalendlyPoll();
  await scheduler.runCalendlyDelivery();
  assert.equal(h.wa.sent.length, 1);
  assert.equal(h.wa.sent[0].to, JID, 'entrega al JID que escribió, no al número de closers.js');
});

test('entrega estricta: opt-in sin contact_jid (sembrado/grandfathered) → NO entrega (cero envío en frío)', async () => {
  // Item 1: sin hilo establecido NO se envía — preferimos perder el push antes que
  // mandar en frío al número canónico que quizá nunca escribió (anti-ban).
  const now = Date.now();
  const events = [makeEvent({ uuid: 'noj', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
  const h = installHarness(scheduler, {
    events,
    optins: [{ phone: SALAZAR_PHONE, contactJid: null }], // verificado pero SIN hilo
    nowMs: now,
  });
  await scheduler.runCalendlyPoll();
  await scheduler.runCalendlyDelivery();
  assert.equal(h.wa.sent.length, 0, 'sin contact_jid no se entrega nada');
  assert.equal(h.store._rows[0].status, 'skipped', 'el push queda omitido, no enviado');
});

// ─── Item 2: botón de pánico (/calendly on|off) ───────────────────────────────

test('pausa global: con DRY_RUN=false y opt-in válido, pausado NO envía y el push queda re-agendable', async () => {
  const now = Date.now();
  const events = [makeEvent({ uuid: 'pause', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
  const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: now });
  h.store.setCalendlyPaused(true);

  await scheduler.runCalendlyPoll();
  await scheduler.runCalendlyDelivery();
  assert.equal(h.wa.sent.length, 0, 'pausa global corta el envío');
  assert.equal(h.store._rows[0].status, 'scheduled', 'NO se consume: vuelve a scheduled para reanudar al despausar');

  // Al despausar, el mismo push (la llamada sigue en el futuro) se entrega.
  h.store.setCalendlyPaused(false);
  await scheduler.runCalendlyDelivery();
  assert.equal(h.wa.sent.length, 1, 'al reactivar se reanuda el push pendiente');
});

test('pausa por-closer: solo se corta al closer pausado, los demás reciben', async () => {
  const now = Date.now();
  const SALAZAR_JID = `573054312905@s.whatsapp.net`;
  const events = [
    makeEvent({ uuid: 'A', startInMin: 20, closerEmail: SALAZAR, nowMs: now }),
    makeEvent({ uuid: 'B', startInMin: 20, closerEmail: 'sebastian@30x.com', nowMs: now }),
  ];
  const h = installHarness(scheduler, {
    events,
    optins: [SALAZAR_PHONE, '+573102212005'], // Salazar + Rodriguez, ambos con hilo
    nowMs: now,
  });
  h.store.setCloserPaused(SALAZAR_PHONE, true);

  await scheduler.runCalendlyPoll();
  await scheduler.runCalendlyDelivery();
  assert.equal(h.wa.sent.length, 1, 'solo el closer no pausado recibe');
  assert.notEqual(h.wa.sent[0].to, SALAZAR_JID, 'no fue Salazar (pausado)');
  const salazarRow = h.store._rows.find((r) => r.event_uuid === 'A');
  assert.equal(salazarRow.status, 'scheduled', 'el push del closer pausado queda re-agendable');
});

test('dry-run: no envía aunque haya opt-in', async () => {
  process.env.CALENDLY_DRY_RUN = 'true';
  const now = Date.now();
  const events = [makeEvent({ uuid: 'dry', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
  const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: now });
  await scheduler.runCalendlyPoll();
  await scheduler.runCalendlyDelivery();
  assert.equal(h.wa.sent.length, 0, 'dry-run no manda WhatsApp');
  assert.equal(h.store._rows[0].status, 'sent', 'en dry-run igual se marca sent');
});

// ─── Decisión 5: alertas a admin ──────────────────────────────────────────────

test('alerta: closer sin mapear → DM al admin + health.unmapped', async () => {
  const now = Date.now();
  const events = [makeEvent({ uuid: 'unm', startInMin: 120, closerEmail: 'desconocido@x.com', nowMs: now })];
  const h = installHarness(scheduler, { events, optins: [], nowMs: now });
  await scheduler.runCalendlyPoll();
  assert.equal(h.store._rows.length, 0, 'no se agenda push para un host sin closer');
  const alert = h.wa.sent.find((m) => m.to === '129446371655733@lid');
  assert.ok(alert, 'el admin recibe alerta');
  assert.match(alert.text, /sin mapear/i);
  assert.equal(getHealth().unmapped.length, 1);
});

test('alerta: token rechazado (401) → DM al admin + health.lastError', async () => {
  const now = Date.now();
  const h = installHarness(scheduler, {
    events: [],
    nowMs: now,
    api: { throwError: 'Calendly 401: token inválido' },
  });
  await scheduler.runCalendlyPoll();
  const alert = h.wa.sent.find((m) => m.to === '129446371655733@lid');
  assert.ok(alert, 'el admin recibe alerta de token');
  assert.match(alert.text, /token/i);
  assert.ok(getHealth().lastError);
});

// ─── Digests Push 1 / Push 2 ──────────────────────────────────────────────────

test('digest Push 2 (hoy): agrupa por closer y envía a los opted-in', async () => {
  // Dos llamadas hoy a las 10:00 y 14:00 hora Bogotá del mismo closer.
  const today = new Date();
  const y = today.getFullYear();
  const mo = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  // 10:00 Bogotá = 15:00Z ; 14:00 Bogotá = 19:00Z (UTC-5)
  const events = [
    makeEvent({ uuid: 'd1', startIso: `${y}-${mo}-${d}T15:00:00.000Z`, closerEmail: SALAZAR, prospectName: 'Ana Gómez' }),
    makeEvent({ uuid: 'd2', startIso: `${y}-${mo}-${d}T19:00:00.000Z`, closerEmail: SALAZAR, prospectName: 'Beto Ruiz' }),
  ];
  // Reloj a las 06:30 Bogotá de hoy = 11:30Z
  const nowMs = Date.parse(`${y}-${mo}-${d}T11:30:00.000Z`);
  const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs });

  await scheduler.runPush2();
  assert.equal(h.wa.sent.length, 1, 'un digest al closer');
  assert.match(h.wa.sent[0].text, /Push 2/);
  assert.match(h.wa.sent[0].text, /tienes 2 llamadas/);
  assert.ok(h.wa.sent[0].text.indexOf('Ana') < h.wa.sent[0].text.indexOf('Beto'), 'ordenado por hora');
});
