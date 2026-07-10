// test/stripe.test.js
// Cubre el lector mínimo de Stripe (src/stripe/client.js): paginación con
// has_more/starting_after, filtro de status succeeded y propagación de errores.
// Sin red: se inyecta fetchImpl (DI mínima). No toca DB → corre en Windows.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { fetchSucceededPaymentTimestamps } from '../src/stripe/client.js';

const KEY_BACKUP = process.env.STRIPE_API_KEY;

beforeEach(() => {
  process.env.STRIPE_API_KEY = 'rk_test_dummy';
});

afterEach(() => {
  if (KEY_BACKUP === undefined) delete process.env.STRIPE_API_KEY;
  else process.env.STRIPE_API_KEY = KEY_BACKUP;
});

const okPage = (data, hasMore) => ({
  ok: true,
  json: async () => ({ data, has_more: hasMore }),
});

test('pagina con starting_after y devuelve solo los created de los succeeded', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (calls.length === 1) {
      return okPage(
        [
          { id: 'pi_1', status: 'succeeded', created: 1000 },
          { id: 'pi_2', status: 'requires_payment_method', created: 1001 },
          { id: 'pi_3', status: 'canceled', created: 1002 },
        ],
        true
      );
    }
    return okPage([{ id: 'pi_4', status: 'succeeded', created: 1003 }], false);
  };

  const created = await fetchSucceededPaymentTimestamps({ createdGteSec: 500, fetchImpl });
  assert.deepEqual(created, [1000, 1003]);

  assert.equal(calls.length, 2);
  // Auth por header Bearer con la restricted key.
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer rk_test_dummy');
  // Primera página: limit + created[gte] (URL-encoded), sin cursor.
  assert.match(calls[0].url, /limit=100/);
  assert.match(calls[0].url, /created%5Bgte%5D=500/);
  assert.doesNotMatch(calls[0].url, /starting_after/);
  // Segunda página: cursor = id del último intent de la página anterior.
  assert.match(calls[1].url, /starting_after=pi_3/);
});

test('propaga el error HTTP con status y cuerpo (el caller decide el fallback)', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    text: async () => '{"error":{"message":"Invalid API Key"}}',
  });
  await assert.rejects(
    fetchSucceededPaymentTimestamps({ createdGteSec: 500, fetchImpl }),
    /\[stripe\] pagos 401.*Invalid API Key/
  );
});

test('sin STRIPE_API_KEY lanza antes de tocar la red', async () => {
  delete process.env.STRIPE_API_KEY;
  const fetchImpl = async () => {
    throw new Error('no debería llamar a la red');
  };
  await assert.rejects(fetchSucceededPaymentTimestamps({ fetchImpl }), /falta STRIPE_API_KEY/);
});

test('página vacía corta la paginación aunque has_more venga true (defensivo)', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return okPage([], true);
  };
  const created = await fetchSucceededPaymentTimestamps({ fetchImpl });
  assert.deepEqual(created, []);
  assert.equal(calls, 1);
});
