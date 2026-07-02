// test/calendly.outcome-logic.test.js
// Tests PUROS de la decisión de captura (§18.AB). Sin DB/WA → Windows.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { decideOutcomeReply } = await import('../src/calendly/outcome-logic.js');

test('paso 1: asistencia ininteligible → re-preguntar asistencia', () => {
  assert.deepEqual(decideOutcomeReply({ asistencia: null }, 'jajaja'), {
    kind: 'reprompt',
    step: 'asistencia',
  });
});

test('paso 1: Show → guardar asistencia y seguir al resultado', () => {
  assert.deepEqual(decideOutcomeReply({ asistencia: null }, '1'), {
    kind: 'asistencia',
    asistencia: 'show',
    followup: 'resultado',
  });
});

test('paso 1: No show → guardar asistencia y confirmar (sin resultado)', () => {
  assert.deepEqual(decideOutcomeReply({ asistencia: null }, 'no llegó'), {
    kind: 'asistencia',
    asistencia: 'no_show',
    followup: 'confirm',
  });
});

test('paso 2: con asistencia=show, parsea el resultado', () => {
  assert.deepEqual(decideOutcomeReply({ asistencia: 'show' }, 'cerró venta'), {
    kind: 'resultado',
    resultado: 'venta_cerrada',
  });
});

test('paso 2: resultado ininteligible → re-preguntar resultado', () => {
  assert.deepEqual(decideOutcomeReply({ asistencia: 'show' }, 'mmm'), {
    kind: 'reprompt',
    step: 'resultado',
  });
});
