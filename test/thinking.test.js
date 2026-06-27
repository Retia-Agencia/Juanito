// test/thinking.test.js
// Gate de soporte de thinking adaptativo. Es la barrera que evita un 400 cuando
// CLAUDE_THINKING=on pero el modelo de razonamiento no soporta adaptive/effort
// (Haiku 4.5, Sonnet 4.5, modelos viejos). Runner nativo: `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supportsAdaptiveThinking } from '../src/claude/index.js';

test('modelos 4.6+ soportan thinking adaptativo', () => {
  for (const m of [
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-fable-5',
  ]) {
    assert.equal(supportsAdaptiveThinking(m), true, `${m} debería soportar`);
  }
});

test('Haiku 4.5, Sonnet 4.5 y modelos viejos NO soportan (el flag se ignora, no 400)', () => {
  for (const m of [
    'claude-haiku-4-5-20251001',
    'claude-haiku-4-5',
    'claude-sonnet-4-5',
    'claude-3-5-sonnet-20241022',
    'claude-opus-4-1',
  ]) {
    assert.equal(supportsAdaptiveThinking(m), false, `${m} NO debería soportar`);
  }
});

test('entrada vacía/nula es segura (false, sin throw)', () => {
  assert.equal(supportsAdaptiveThinking(''), false);
  assert.equal(supportsAdaptiveThinking(undefined), false);
  assert.equal(supportsAdaptiveThinking(null), false);
});
