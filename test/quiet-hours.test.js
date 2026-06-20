// test/quiet-hours.test.js
// Cubre isWithinQuietHours() (ventana de descanso para aprobaciones). Puro: corre nativo.
// Fijamos TZ=UTC para que los minutos locales == minutos UTC del `now` que pasamos.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { isWithinQuietHours } = await import('../src/common/utils.js');

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const at = (hhmm) => new Date(`2026-06-19T${hhmm}:00Z`);

test('sin env de quiet hours → siempre false (sin ventana)', () => {
  withEnv({ TZ: 'UTC', QUIET_HOURS_START: undefined, QUIET_HOURS_END: undefined }, () => {
    assert.equal(isWithinQuietHours(at('03:00')), false);
    assert.equal(isWithinQuietHours(at('23:00')), false);
  });
});

test('ventana que cruza medianoche (21:00–07:00)', () => {
  withEnv({ TZ: 'UTC', QUIET_HOURS_START: '21:00', QUIET_HOURS_END: '07:00' }, () => {
    assert.equal(isWithinQuietHours(at('23:00')), true, 'noche');
    assert.equal(isWithinQuietHours(at('03:00')), true, 'madrugada');
    assert.equal(isWithinQuietHours(at('21:00')), true, 'inicio inclusivo');
    assert.equal(isWithinQuietHours(at('06:59')), true, 'justo antes del fin');
    assert.equal(isWithinQuietHours(at('07:00')), false, 'fin exclusivo');
    assert.equal(isWithinQuietHours(at('12:00')), false, 'mediodía');
  });
});

test('ventana normal sin cruce (09:00–17:00)', () => {
  withEnv({ TZ: 'UTC', QUIET_HOURS_START: '09:00', QUIET_HOURS_END: '17:00' }, () => {
    assert.equal(isWithinQuietHours(at('12:00')), true);
    assert.equal(isWithinQuietHours(at('09:00')), true, 'inicio inclusivo');
    assert.equal(isWithinQuietHours(at('17:00')), false, 'fin exclusivo');
    assert.equal(isWithinQuietHours(at('08:59')), false);
    assert.equal(isWithinQuietHours(at('23:00')), false);
  });
});

test('start === end → ventana nula (false)', () => {
  withEnv({ TZ: 'UTC', QUIET_HOURS_START: '08:00', QUIET_HOURS_END: '08:00' }, () => {
    assert.equal(isWithinQuietHours(at('08:00')), false);
    assert.equal(isWithinQuietHours(at('20:00')), false);
  });
});
