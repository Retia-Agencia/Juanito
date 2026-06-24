// test/utils-mask.test.js
// maskJid(): enmascarado de JID/LID/número para logs (H9). Puro: corre nativo en Windows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskJid, validatePhone } from '../src/common/utils.js';

test('maskJid: número con sufijo whatsapp → últimos 4 + sufijo', () => {
  assert.equal(maskJid('573105643297@s.whatsapp.net'), '…3297@s.whatsapp.net');
});

test('maskJid: LID → últimos 4 + @lid', () => {
  assert.equal(maskJid('144268136038585@lid'), '…8585@lid');
});

test('maskJid: sin sufijo → últimos 4', () => {
  assert.equal(maskJid('573105643297'), '…3297');
});

test('maskJid: cuerpo corto (≤4) no rompe', () => {
  assert.equal(maskJid('12@lid'), '…12@lid');
});

test('maskJid: vacío/nulo/undefined → cadena vacía', () => {
  assert.equal(maskJid(''), '');
  assert.equal(maskJid(null), '');
  assert.equal(maskJid(undefined), '');
});

test('maskJid: nunca filtra el cuerpo completo del identificador', () => {
  const out = maskJid('573105643297@s.whatsapp.net');
  assert.ok(!out.includes('573105'), 'no debe contener el prefijo del número');
});

// ─── validatePhone (§18 1A — no confundir números) ────────────────────────────

test('validatePhone: número plausible → ok + solo dígitos', () => {
  const v = validatePhone('300 123 4567');
  assert.equal(v.ok, true);
  assert.equal(v.digits, '3001234567');
  assert.equal(v.reason, null);
});

test('validatePhone: acepta prefijo de país y formato con +/guiones', () => {
  assert.equal(validatePhone('+57 310-221-2005').ok, true);
  assert.equal(validatePhone('+57 310-221-2005').digits, '573102212005');
});

test('validatePhone: vacío/nulo → no ok', () => {
  assert.equal(validatePhone('').ok, false);
  assert.equal(validatePhone(null).ok, false);
  assert.equal(validatePhone('   ').ok, false); // sin dígitos
});

test('validatePhone: muy corto (<7 dígitos) → no ok con razón', () => {
  const v = validatePhone('123 45');
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'muy corto');
});

test('validatePhone: muy largo (>15 dígitos) → no ok con razón', () => {
  const v = validatePhone('1234567890123456');
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'muy largo');
});
