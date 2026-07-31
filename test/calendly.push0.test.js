// test/calendly.push0.test.js
// Push 0 — aviso de "nueva call HOY" (§18.C, idea Sebas).
// Tier 1: puro + harness (sin DB nativa, sin red, sin WhatsApp real). Cubre la
// lógica de decisión (decidePush0), los helpers de zona horaria (isSameDayInTz /
// push2HasRunToday / parseDailyCronHM) y los escenarios de integración por el
// scheduler (se agenda, se entrega, dedup, gating por opt-in y por digest).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';

import * as scheduler from '../src/scheduler/calendly.js';
import { __resetHealth } from '../src/calendly/health.js';
import {
  isSameDayInTz,
  push2HasRunToday,
  parseDailyCronHM,
  buildPush0Message,
} from '../src/calendly/index.js';
import { decidePush0 } from '../src/calendly/push-logic.js';
import { installHarness, makeEvent } from './helpers/calendly-harness.js';

const TZ = 'America/Bogota';
const SALAZAR = 'sebastian.salazar@30x.com';
const SALAZAR_PHONE = '+573054312905';

// Bogotá = UTC-5 (sin DST). Push 2 por default a las 06:30 Bogotá = 11:30 UTC.
//   09:00 Bogotá (post Push 2) = 14:00 UTC ; 05:00 Bogotá (pre Push 2) = 10:00 UTC.
const NOW_POST = Date.parse('2026-06-15T14:00:00.000Z'); // hoy 09:00 Bogotá
const NOW_PRE = Date.parse('2026-06-15T10:00:00.000Z'); // hoy 05:00 Bogotá
const CALL_TODAY = '2026-06-15T16:00:00.000Z'; // hoy 11:00 Bogotá (futuro vs 09:00)
const CALL_TOMORROW = '2026-06-16T16:00:00.000Z'; // mañana 11:00 Bogotá

beforeEach(() => {
  process.env.CALENDLY_DRY_RUN = 'false';
  process.env.CALENDLY_REQUIRE_OPTIN = 'true';
  process.env.CALENDLY_PUSH3_LEAD_MIN = '25';
  process.env.ADMIN_LID = '129446371655733@lid';
  delete process.env.CALENDLY_PUSH0_ENABLED; // default: activo
  delete process.env.CALENDLY_PUSH0_RECENT_MIN;
  delete process.env.CALENDLY_PUSH2_CRON; // default '30 6 * * *'
  __resetHealth();
  scheduler.__resetDeps();
});

const push0Rows = (store) => store._rows.filter((r) => r.push_n === 0);

// ─── Helpers de zona horaria (puros) ──────────────────────────────────────────

test('parseDailyCronHM: cron diario simple sí, cron de intervalo no', () => {
  assert.deepEqual(parseDailyCronHM('30 6 * * *'), { hour: 6, minute: 30 });
  assert.deepEqual(parseDailyCronHM('0 19 * * *'), { hour: 19, minute: 0 });
  assert.equal(parseDailyCronHM('*/5 * * * *'), null);
  assert.equal(parseDailyCronHM(''), null);
});

test('push2HasRunToday: true después de 06:30 Bogotá, false antes', () => {
  assert.equal(push2HasRunToday('30 6 * * *', TZ, new Date(NOW_POST)), true);
  assert.equal(push2HasRunToday('30 6 * * *', TZ, new Date(NOW_PRE)), false);
  // Cron no diario → fallback true (no bloquea el aviso).
  assert.equal(push2HasRunToday('*/5 * * * *', TZ, new Date(NOW_POST)), true);
});

test('isSameDayInTz: compara por día de PARED en tz (no UTC)', () => {
  assert.equal(isSameDayInTz(CALL_TODAY, TZ, new Date(NOW_POST)), true);
  assert.equal(isSameDayInTz(CALL_TOMORROW, TZ, new Date(NOW_POST)), false);
  // 2026-06-16T02:00Z = 2026-06-15 21:00 Bogotá → MISMO día que las 09:00 del 15.
  assert.equal(isSameDayInTz('2026-06-16T02:00:00.000Z', TZ, new Date(NOW_POST)), true);
});

// ─── Decisión pura (decidePush0) ──────────────────────────────────────────────

test('decidePush0: caso canónico (hoy, futura, reciente, post Push 2) → notifica', () => {
  const r = decidePush0({
    startMs: Date.parse(CALL_TODAY),
    createdAtMs: NOW_POST - 2 * 60000,
    nowMs: NOW_POST,
    isToday: true,
    push2HasRun: true,
  });
  assert.equal(r.notify, true);
  assert.equal(r.reason, 'new-booking-today');
});

test('decidePush0: descarta por not-today / call-passed / not-recent / push2-pending', () => {
  const base = { startMs: Date.parse(CALL_TODAY), createdAtMs: NOW_POST - 60000, nowMs: NOW_POST, isToday: true, push2HasRun: true };
  assert.equal(decidePush0({ ...base, isToday: false }).reason, 'not-today');
  assert.equal(decidePush0({ ...base, startMs: NOW_POST - 60000 }).reason, 'call-passed');
  assert.equal(decidePush0({ ...base, createdAtMs: NOW_POST - 30 * 60000 }).reason, 'not-recent');
  assert.equal(decidePush0({ ...base, push2HasRun: false }).reason, 'push2-pending');
  assert.equal(decidePush0({ ...base, createdAtMs: NaN }).reason, 'no-created-at');
});

// ─── Plantilla ────────────────────────────────────────────────────────────────

test('buildPush0Message: heads-up informativo, sin link wa.me', () => {
  const msg = buildPush0Message({ name: 'Ana Gómez', phone: '+573001112222', startIso: CALL_TODAY, tz: TZ });
  assert.match(msg, /Nueva call HOY/);
  assert.match(msg, /Ana Gómez/);
  assert.match(msg, /\+573001112222/);
  assert.doesNotMatch(msg, /wa\.me/);
});

// ─── Escenarios de integración (poll + delivery) ──────────────────────────────

test('happy path: nueva call HOY tras el Push 2 → se agenda Push 0 y se entrega', async () => {
  const events = [makeEvent({ uuid: 'p0', startIso: CALL_TODAY, createdInMin: -2, closerEmail: SALAZAR, prospectName: 'Ana Gómez', nowMs: NOW_POST })];
  const { store, wa } = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: NOW_POST });

  await scheduler.runCalendlyPoll();
  assert.equal(push0Rows(store).length, 1, 'se agendó el Push 0');
  assert.ok(store._rows.find((r) => r.push_n === 3), 'el Push 3 también se agenda como siempre');

  await scheduler.runCalendlyDelivery();
  const p0 = push0Rows(store)[0];
  assert.equal(p0.status, 'sent');
  assert.equal(wa.sent.length, 1, 'solo el Push 0 vence ahora (el Push 3 está en el futuro)');
  assert.match(wa.sent[0].text, /Nueva call HOY/);
  assert.match(wa.sent[0].text, /Ana/);
});

test('pre Push 2 (madrugada): el digest lo cubrirá → NO se agenda Push 0', async () => {
  const events = [makeEvent({ uuid: 'early', startIso: CALL_TODAY, createdInMin: -2, closerEmail: SALAZAR, nowMs: NOW_PRE })];
  const { store } = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: NOW_PRE });
  await scheduler.runCalendlyPoll();
  assert.equal(push0Rows(store).length, 0, 'antes del Push 2 no hay Push 0 (evita doble-aviso)');
});

test('reserva vieja que recién entró a la ventana → NO Push 0', async () => {
  // created_at por default es −2 días: no es un booking nuevo.
  const events = [makeEvent({ uuid: 'old', startIso: CALL_TODAY, closerEmail: SALAZAR, nowMs: NOW_POST })];
  const { store } = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: NOW_POST });
  await scheduler.runCalendlyPoll();
  assert.equal(push0Rows(store).length, 0, 'una reserva no-reciente no dispara aviso');
});

test('nueva call para MAÑANA → NO Push 0 (solo mismo día)', async () => {
  const events = [makeEvent({ uuid: 'tom', startIso: CALL_TOMORROW, createdInMin: -2, closerEmail: SALAZAR, nowMs: NOW_POST })];
  const { store } = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: NOW_POST });
  await scheduler.runCalendlyPoll();
  assert.equal(push0Rows(store).length, 0, 'las de días futuros las cubre Push 1/2');
});

test('dedup: dos polls seguidos → un solo Push 0', async () => {
  const events = [makeEvent({ uuid: 'dedup', startIso: CALL_TODAY, createdInMin: -2, closerEmail: SALAZAR, nowMs: NOW_POST })];
  const { store, wa } = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: NOW_POST });
  await scheduler.runCalendlyPoll();
  await scheduler.runCalendlyPoll();
  assert.equal(push0Rows(store).length, 1, 'la unicidad (event_uuid, push_n=0) evita duplicados');
  await scheduler.runCalendlyDelivery();
  assert.equal(wa.sent.length, 1);
});

test('anti-ban: Push 0 sin opt-in → no se envía, pero queda reintentable', async () => {
  const events = [makeEvent({ uuid: 'noopt', startIso: CALL_TODAY, createdInMin: -2, closerEmail: SALAZAR, nowMs: NOW_POST })];
  const { store, wa } = installHarness(scheduler, { events, optins: [], nowMs: NOW_POST });
  await scheduler.runCalendlyPoll();
  await scheduler.runCalendlyDelivery();
  assert.equal(wa.sent.length, 0, 'el Push 0 respeta el gate de opt-in igual que los demás');
  assert.equal(push0Rows(store)[0].status, 'scheduled', 'sigue vivo para reintentar, no quemado');
});

test('flag CALENDLY_PUSH0_ENABLED=false → no se agenda Push 0', async () => {
  process.env.CALENDLY_PUSH0_ENABLED = 'false';
  const events = [makeEvent({ uuid: 'off', startIso: CALL_TODAY, createdInMin: -2, closerEmail: SALAZAR, nowMs: NOW_POST })];
  const { store } = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: NOW_POST });
  await scheduler.runCalendlyPoll();
  assert.equal(push0Rows(store).length, 0);
  assert.ok(store._rows.find((r) => r.push_n === 3), 'el Push 3 sigue funcionando con el flag apagado');
});
