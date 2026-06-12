// test/subject-cache.test.js
// Tests PUROS del TTL-cache de subjects de grupo (§18.D P1-b).
// Reloj inyectado — sin timers reales. Corre nativo en Windows:
// node --test test/subject-cache.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTtlCache } from '../src/whatsapp/subject-cache.js';

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('hit dentro del TTL, miss después de expirar', () => {
  const clock = fakeClock();
  const cache = createTtlCache({ ttlMs: 10_000, negativeTtlMs: 1_000, now: clock.now });

  cache.set('g1@g.us', 'Ventas EstadoX');
  assert.equal(cache.get('g1@g.us'), 'Ventas EstadoX');

  clock.advance(9_999);
  assert.equal(cache.get('g1@g.us'), 'Ventas EstadoX');

  clock.advance(1); // justo en el límite → expira
  assert.equal(cache.get('g1@g.us'), undefined);
  assert.equal(cache.size(), 0); // la entrada expirada se limpia
});

test('miss para una key que nunca se guardó', () => {
  const cache = createTtlCache({ ttlMs: 10_000, now: () => 0 });
  assert.equal(cache.get('nope@g.us'), undefined);
});

test('entrada negativa (fallback de error) expira con el TTL corto', () => {
  const clock = fakeClock();
  const cache = createTtlCache({ ttlMs: 10_000, negativeTtlMs: 1_000, now: clock.now });

  cache.set('g1@g.us', 'g1@g.us', { negative: true });
  assert.equal(cache.get('g1@g.us'), 'g1@g.us');

  clock.advance(1_000); // TTL negativo vencido → se reintenta el fetch real
  assert.equal(cache.get('g1@g.us'), undefined);
});

test('set sobrescribe valor y renueva el TTL', () => {
  const clock = fakeClock();
  const cache = createTtlCache({ ttlMs: 10_000, now: clock.now });

  cache.set('g1@g.us', 'Nombre Viejo');
  clock.advance(9_000);
  cache.set('g1@g.us', 'Nombre Nuevo'); // ej: groups.update con subject nuevo
  clock.advance(9_000); // 18s desde el primer set, 9s desde el segundo
  assert.equal(cache.get('g1@g.us'), 'Nombre Nuevo');
});

test('delete invalida la entrada (ej: group-participants.update)', () => {
  const cache = createTtlCache({ ttlMs: 10_000, now: () => 0 });
  cache.set('g1@g.us', 'Grupo');
  cache.delete('g1@g.us');
  assert.equal(cache.get('g1@g.us'), undefined);
});
