// test/feedback-clamp.test.js
// clampFeedback(): encajonado/truncado del feedback del jefe antes de inyectarlo en los
// prompts de generación (H5). Importa claude/index.js → necesita la API key seteada.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

const { clampFeedback, FEEDBACK_MAX_CHARS } = await import('../src/claude/index.js');

test('clampFeedback: texto corto pasa igual (con trim)', () => {
  assert.equal(clampFeedback('  usa más emojis  '), 'usa más emojis');
});

test('clampFeedback: vacío/nulo → cadena vacía', () => {
  assert.equal(clampFeedback(''), '');
  assert.equal(clampFeedback(null), '');
  assert.equal(clampFeedback(undefined), '');
});

test('clampFeedback: trunca al máximo y marca [truncado]', () => {
  const long = 'a'.repeat(FEEDBACK_MAX_CHARS + 100);
  const out = clampFeedback(long);
  assert.match(out, /\[truncado\]$/);
  assert.ok(out.length <= FEEDBACK_MAX_CHARS + 20, 'no excede el máximo + el sufijo');
  assert.ok(out.startsWith('a'.repeat(50)), 'conserva el inicio del feedback');
});
