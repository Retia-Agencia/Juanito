// test/setting-logic.test.js
// Tests PUROS de la lógica del setteo (§18.AD). Sin DB/red/deps nativas.
//   node --test test/setting-logic.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toDialable,
  computeEnrollment,
  computeSettingTouches,
  firstNameOf,
  toSqliteUtc,
} from '../src/setting/setting-logic.js';

test('toDialable: móvil colombiano sin código país → antepone 57', () => {
  assert.equal(toDialable('3105551234', '57'), '573105551234');
  assert.equal(toDialable('310 555 1234', '57'), '573105551234');
});

test('toDialable: número que ya trae código país (≥11 dígitos) se respeta', () => {
  assert.equal(toDialable('573105551234', '57'), '573105551234');
  assert.equal(toDialable('+57 310 555 1234', '57'), '573105551234');
});

test('toDialable: basura o muy corto → cadena vacía', () => {
  assert.equal(toDialable('', '57'), '');
  assert.equal(toDialable('123', '57'), '');
  assert.equal(toDialable(null, '57'), '');
});

test('computeEnrollment: lead reciente enrola; viejo no; sin fecha no', () => {
  const now = Date.parse('2026-07-05T12:00:00Z');
  const maxAge = 48 * 3600 * 1000;
  assert.equal(computeEnrollment({ submittedMs: now - 3600 * 1000, nowMs: now, enrollMaxAgeMs: maxAge }).enroll, true);
  assert.equal(computeEnrollment({ submittedMs: now - 72 * 3600 * 1000, nowMs: now, enrollMaxAgeMs: maxAge }).enroll, false);
  assert.equal(computeEnrollment({ submittedMs: NaN, nowMs: now, enrollMaxAgeMs: maxAge }).enroll, false);
});

test('computeEnrollment: fecha en el futuro no enrola', () => {
  const now = Date.parse('2026-07-05T12:00:00Z');
  assert.equal(computeEnrollment({ submittedMs: now + 10 * 60000, nowMs: now, enrollMaxAgeMs: 1e12 }).enroll, false);
});

test('computeSettingTouches: 2 toques desde ahora (2h y 2h+48h)', () => {
  const now = Date.parse('2026-07-05T12:00:00Z');
  const t = computeSettingTouches({ nowMs: now, touch1DelayMin: 120, touch2DelayMin: 2880 });
  assert.equal(t.length, 2);
  assert.deepEqual(t.map((x) => x.touch_n), [1, 2]);
  assert.equal(t[0].dueMs, now + 120 * 60000);
  assert.equal(t[1].dueMs, now + (120 + 2880) * 60000);
});

test('firstNameOf: primer token; vacío → cadena vacía', () => {
  assert.equal(firstNameOf('Ana María Pérez'), 'Ana');
  assert.equal(firstNameOf('  '), '');
});

test('toSqliteUtc: instante → YYYY-MM-DD HH:MM:SS en UTC', () => {
  assert.equal(toSqliteUtc(Date.parse('2026-07-05T12:34:56Z')), '2026-07-05 12:34:56');
});
