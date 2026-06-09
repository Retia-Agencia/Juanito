// test/calendly.push-logic.test.js
// Tests PUROS de la lógica de decisión de pushes (sin DB, sin red).
// Cubren la decisión 4b (catch-up) y el bug #2 (reagenda tras envío).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computePush3Schedule,
  decidePushAction,
  sqliteUtcToMs,
} from '../src/calendly/push-logic.js';

const MIN = 60000;
const NOW = Date.parse('2026-06-10T12:00:00Z');
const iso = (minFromNow) => new Date(NOW + minFromNow * MIN).toISOString();

// ─── computePush3Schedule (decisión 4b) ───────────────────────────────────────

test('computePush3Schedule: llamada futura normal → agenda a start-lead, no inmediato', () => {
  const r = computePush3Schedule({ startIso: iso(120), leadMin: 25, nowMs: NOW });
  assert.equal(r.shouldSchedule, true);
  assert.equal(r.immediate, false);
  assert.equal(r.reason, 'normal');
  assert.equal(r.dueMs, NOW + 120 * MIN - 25 * MIN);
});

test('computePush3Schedule: reserva tardía (todos los triggers pasaron) → catch-up inmediato', () => {
  // Llamada en 20 min, lead 25 → el due normal ya pasó, pero la llamada es futura.
  const r = computePush3Schedule({ startIso: iso(20), leadMin: 25, nowMs: NOW });
  assert.equal(r.shouldSchedule, true);
  assert.equal(r.immediate, true);
  assert.equal(r.reason, 'catch-up');
  assert.equal(r.dueMs, NOW); // se manda ya
});

test('computePush3Schedule: llamada ya empezó/pasó → no agenda', () => {
  const r = computePush3Schedule({ startIso: iso(-10), leadMin: 25, nowMs: NOW });
  assert.equal(r.shouldSchedule, false);
  assert.equal(r.reason, 'call-passed');
});

test('computePush3Schedule: start inválido → no agenda', () => {
  const r = computePush3Schedule({ startIso: 'no-es-fecha', leadMin: 25, nowMs: NOW });
  assert.equal(r.shouldSchedule, false);
  assert.equal(r.reason, 'invalid-start');
});

// ─── decidePushAction (bug #2 + idempotencia) ─────────────────────────────────

const incoming = (callStartMin, dueMin) => ({
  event_uuid: 'e1',
  push_n: 3,
  call_start: sqlite(iso(callStartMin)),
  due_at: sqlite(iso(dueMin)),
});
function sqlite(isoStr) {
  return isoStr.slice(0, 19).replace('T', ' ');
}

test('decidePushAction: sin fila previa → insert', () => {
  assert.equal(decidePushAction({ existing: null, incoming: incoming(120, 95), nowMs: NOW }).action, 'insert');
});

test('decidePushAction: misma hora → unchanged (idempotente cada 5 min)', () => {
  const existing = { id: 1, status: 'scheduled', call_start: sqlite(iso(120)) };
  assert.equal(decidePushAction({ existing, incoming: incoming(120, 95), nowMs: NOW }).action, 'unchanged');
});

test('decidePushAction: scheduled + hora cambió → reschedule (sin reset)', () => {
  const existing = { id: 1, status: 'scheduled', call_start: sqlite(iso(120)) };
  const r = decidePushAction({ existing, incoming: incoming(180, 155), nowMs: NOW });
  assert.equal(r.action, 'reschedule');
  assert.equal(r.resetFromSent, false);
});

test('decidePushAction: BUG #2 — sent + reagendada a futuro → reschedule con resetFromSent', () => {
  const existing = { id: 1, status: 'sent', call_start: sqlite(iso(30)) };
  // reagendada a +180 min; el nuevo due (+155) es futuro
  const r = decidePushAction({ existing, incoming: incoming(180, 155), nowMs: NOW });
  assert.equal(r.action, 'reschedule');
  assert.equal(r.resetFromSent, true);
});

test('decidePushAction: sent + reagendada a hora ya pasada → unchanged (no re-armar)', () => {
  const existing = { id: 1, status: 'sent', call_start: sqlite(iso(30)) };
  const r = decidePushAction({ existing, incoming: incoming(-30, -55), nowMs: NOW });
  assert.equal(r.action, 'unchanged');
  assert.equal(r.reason, 'sent-new-due-past');
});

test('decidePushAction: skipped no se resucita automáticamente', () => {
  const existing = { id: 1, status: 'skipped', call_start: sqlite(iso(30)) };
  assert.equal(decidePushAction({ existing, incoming: incoming(180, 155), nowMs: NOW }).action, 'unchanged');
});

test('sqliteUtcToMs round-trip con toSqliteUtc-style string', () => {
  assert.equal(sqliteUtcToMs('2026-06-10 12:00:00'), Date.parse('2026-06-10T12:00:00Z'));
  assert.ok(Number.isNaN(sqliteUtcToMs('')));
});
