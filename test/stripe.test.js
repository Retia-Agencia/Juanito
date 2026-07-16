// test/stripe.test.js
// Cubre el lector mínimo de Stripe (src/stripe/client.js): paginación con
// has_more/starting_after, filtro de status succeeded y propagación de errores.
// Sin red: se inyecta fetchImpl (DI mínima). No toca DB → corre en Windows.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchSucceededPaymentTimestamps,
  fetchSucceededPaymentTimestampsForLink,
} from '../src/stripe/client.js';

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

// ─── Atribución por Payment Link (self-checkout del reporte admin de EstadoX) ───

// Session con su PI expandido. `created` de la session y del PI a propósito distintos:
// en la cuenta real el PI se paga 3-6 min después de abrirse el carrito.
const sess = (id, sessCreated, pi) => ({ id, created: sessCreated, payment_intent: pi });

test('devuelve el created del PAYMENT INTENT, no el de la session', async () => {
  const fetchImpl = async () =>
    okPage([sess('cs_1', 1000, { id: 'pi_1', status: 'succeeded', created: 1240 })], false);

  const created = await fetchSucceededPaymentTimestampsForLink({
    paymentLink: 'plink_x',
    fetchImpl,
  });
  // 1240 (PI), no 1000 (session): es el mismo reloj con el que se cuenta el total del día,
  // así que la resta "total − self-checkout" no puede cruzar el borde de la ventana.
  assert.deepEqual(created, [1240]);
});

test('cuenta solo los PI succeeded e ignora los que vienen sin expandir', async () => {
  const fetchImpl = async () =>
    okPage(
      [
        sess('cs_1', 1000, { id: 'pi_1', status: 'succeeded', created: 1240 }),
        sess('cs_2', 1001, { id: 'pi_2', status: 'requires_payment_method', created: 1241 }),
        sess('cs_3', 1002, { id: 'pi_3', status: 'canceled', created: 1242 }),
        sess('cs_4', 1003, 'pi_4'), // string = sin expandir → no hay created fiable
        sess('cs_5', 1004, null), // carrito abandonado sin PI
      ],
      false
    );

  const created = await fetchSucceededPaymentTimestampsForLink({
    paymentLink: 'plink_x',
    fetchImpl,
  });
  assert.deepEqual(created, [1240]);
});

test('filtra por link, expande el PI y pagina con el id de la session', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (calls.length === 1) {
      return okPage([sess('cs_1', 1000, { id: 'pi_1', status: 'succeeded', created: 1240 })], true);
    }
    return okPage([sess('cs_2', 2000, { id: 'pi_2', status: 'succeeded', created: 2240 })], false);
  };

  const created = await fetchSucceededPaymentTimestampsForLink({
    paymentLink: 'plink_x',
    createdGteSec: 500,
    fetchImpl,
  });
  assert.deepEqual(created, [1240, 2240]);

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /checkout\/sessions/);
  assert.match(calls[0].url, /payment_link=plink_x/);
  assert.match(calls[0].url, /expand%5B%5D=data.payment_intent/);
  assert.match(calls[0].url, /created%5Bgte%5D=500/);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer rk_test_dummy');
  // Cursor = id de la SESSION (es lo que se está listando), no el del PI.
  assert.match(calls[1].url, /starting_after=cs_1/);
});

test('sin paymentLink lanza antes de tocar la red (contar TODAS las sessions sería mentira)', async () => {
  const fetchImpl = async () => {
    throw new Error('no debería llamar a la red');
  };
  await assert.rejects(
    fetchSucceededPaymentTimestampsForLink({ fetchImpl }),
    /falta paymentLink/
  );
});

test('propaga el error HTTP de sessions (el reporte cae al tag del Sheet)', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    text: async () => '{"error":{"message":"no permission on checkout sessions"}}',
  });
  await assert.rejects(
    fetchSucceededPaymentTimestampsForLink({ paymentLink: 'plink_x', fetchImpl }),
    /\[stripe\] sessions 403.*no permission/
  );
});
