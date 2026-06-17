// test/send-queue.test.js
// Tests PUROS de la cola de envío con throttle (§18.D P1-a, anti-ban).
// Sin Baileys, sin DB, sin timers reales — `wait` y `random` inyectados.
// Corre nativo en Windows: node --test test/send-queue.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSendQueue } from '../src/whatsapp/send-queue.js';

// wait falso: registra los delays pedidos y resuelve al instante.
function fakeWait() {
  const delays = [];
  const wait = (ms) => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { wait, delays };
}

test('los envíos salen en orden FIFO y todos resuelven', async () => {
  const { wait } = fakeWait();
  const q = createSendQueue({ minGapMs: 1000, jitterMs: 0, maxQueue: 10, wait });

  const sent = [];
  const mkJob = (id) => () => {
    sent.push(id);
    return Promise.resolve(id);
  };

  const results = await Promise.all([
    q.enqueue(mkJob('a')),
    q.enqueue(mkJob('b')),
    q.enqueue(mkJob('c')),
  ]);

  assert.deepEqual(sent, ['a', 'b', 'c']);
  assert.deepEqual(results, ['a', 'b', 'c']);
});

test('respeta el gap mínimo entre envíos (espera tras CADA envío, incluso el último)', async () => {
  const { wait, delays } = fakeWait();
  const q = createSendQueue({ minGapMs: 1500, jitterMs: 0, maxQueue: 10, wait });

  await Promise.all([q.enqueue(() => Promise.resolve()), q.enqueue(() => Promise.resolve())]);

  // Un sleep después de cada envío (el del último protege contra un enqueue inmediato).
  assert.equal(delays.length, 2);
  for (const d of delays) assert.equal(d, 1500);
});

test('el jitter queda dentro de [minGap, minGap + jitter)', async () => {
  const { wait, delays } = fakeWait();
  // random fijo en 0.5 → jitter determinista de 250ms.
  const q = createSendQueue({ minGapMs: 1000, jitterMs: 500, maxQueue: 10, wait, random: () => 0.5 });

  await q.enqueue(() => Promise.resolve());

  assert.equal(delays[0], 1000 + 250);
});

test('rechaza al exceder maxQueue (descarte anti-flood) sin romper los encolados', async () => {
  const { wait } = fakeWait();
  const q = createSendQueue({ minGapMs: 0, jitterMs: 0, maxQueue: 2, wait });

  // Job que no resuelve hasta que lo soltemos — mantiene la cola ocupada.
  let release;
  const blocker = new Promise((r) => (release = r));
  const p1 = q.enqueue(() => blocker); // en vuelo (sale de la cola al ejecutarse)
  const p2 = q.enqueue(() => Promise.resolve('ok2')); // encolado 1/2
  const p3 = q.enqueue(() => Promise.resolve('ok3')); // encolado 2/2
  const p4 = q.enqueue(() => Promise.resolve('nunca')); // cola llena → rechaza

  await assert.rejects(p4, /send-queue llena/);

  release();
  assert.equal(await p1, undefined);
  assert.equal(await p2, 'ok2');
  assert.equal(await p3, 'ok3');
});

test('un envío que falla rechaza SU promise pero la cola sigue con el resto', async () => {
  const { wait } = fakeWait();
  const q = createSendQueue({ minGapMs: 100, jitterMs: 0, maxQueue: 10, wait });

  const sent = [];
  const pFail = q.enqueue(() => Promise.reject(new Error('boom')));
  const pOk = q.enqueue(() => {
    sent.push('despues-del-fallo');
    return Promise.resolve('ok');
  });

  await assert.rejects(pFail, /boom/);
  assert.equal(await pOk, 'ok');
  assert.deepEqual(sent, ['despues-del-fallo']);
});

test('un enqueue posterior a drenar la cola también sale (re-drain)', async () => {
  const { wait } = fakeWait();
  const q = createSendQueue({ minGapMs: 10, jitterMs: 0, maxQueue: 10, wait });

  assert.equal(await q.enqueue(() => Promise.resolve('primero')), 'primero');
  // La cola ya drenó y soltó el lock — un envío nuevo debe procesarse igual.
  assert.equal(await q.enqueue(() => Promise.resolve('segundo')), 'segundo');
  assert.equal(q.size(), 0);
});

// ─── Espaciado por key (anti-ráfaga por grupo) ─────────────────────────────────
// Reloj virtual: el `wait` falso AVANZA el tiempo, así el gap por-key es testeable.
function virtualClock() {
  let t = 0;
  return { now: () => t, wait: (ms) => { t += ms; return Promise.resolve(); } };
}

test('dos envíos a la MISMA key se separan ≥ perKeyGap', async () => {
  const c = virtualClock();
  const q = createSendQueue({
    minGapMs: 100, jitterMs: 0, maxQueue: 10,
    perKeyGapMs: 8000, perKeyJitterMs: 0,
    wait: c.wait, random: () => 0, now: c.now,
  });

  const sentAt = {};
  const mk = (id) => () => { sentAt[id] = c.now(); return Promise.resolve(id); };

  await Promise.all([
    q.enqueue(mk('a1'), { key: 'g1' }),
    q.enqueue(mk('a2'), { key: 'g1' }),
  ]);

  assert.ok(sentAt.a2 - sentAt.a1 >= 8000, `esperado ≥8000, fue ${sentAt.a2 - sentAt.a1}`);
});

test('keys distintas NO se bloquean entre sí (solo el gap global)', async () => {
  const c = virtualClock();
  const q = createSendQueue({
    minGapMs: 100, jitterMs: 0, maxQueue: 10,
    perKeyGapMs: 8000, perKeyJitterMs: 0,
    wait: c.wait, random: () => 0, now: c.now,
  });

  const sentAt = {};
  const mk = (id) => () => { sentAt[id] = c.now(); return Promise.resolve(id); };

  await Promise.all([
    q.enqueue(mk('g1'), { key: 'g1' }),
    q.enqueue(mk('g2'), { key: 'g2' }),
  ]);

  // El segundo (otra key) sale tras el gap global, NO tras el perKeyGap.
  assert.ok(sentAt.g2 - sentAt.g1 < 8000, 'distinta key no debe esperar el gap por-grupo');
});

test('un grupo saturado no posterga a un envío sin key (DM)', async () => {
  const c = virtualClock();
  const q = createSendQueue({
    minGapMs: 100, jitterMs: 0, maxQueue: 10,
    perKeyGapMs: 8000, perKeyJitterMs: 0,
    wait: c.wait, random: () => 0, now: c.now,
  });

  const order = [];
  const mk = (id) => () => { order.push(id); return Promise.resolve(id); };

  await Promise.all([
    q.enqueue(mk('g1a'), { key: 'g1' }),
    q.enqueue(mk('g1b'), { key: 'g1' }), // tendría que esperar 8s
    q.enqueue(mk('dm'), {}),             // sin key → elegible de inmediato, NO debe quedar atrás
  ]);

  // El DM (sin key) se adelanta al 2º del grupo saturado.
  assert.ok(order.indexOf('dm') < order.indexOf('g1b'), `orden inesperado: ${order.join(',')}`);
});
