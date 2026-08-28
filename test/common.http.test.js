// test/common.http.test.js
// El deadline de los fetch (auditoría 2026-08-26, hallazgo 10). Puro: levanta un server
// HTTP local en loopback, sin red saliente → corre en Windows.
//
// Lo que se fija acá no es "fetch anda", es la propiedad que faltaba: un servidor que
// ACEPTA la conexión y después se calla tiene que producir un ERROR, no un cuelgue. Ese
// cuelgue era el que dejaba el proceso vivo, verde y mudo (§18.AT).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { fetchConDeadline, HTTP_TIMEOUT_MS } from '../src/common/http.js';

let servidor;
let base;
const abiertas = []; // sockets que dejamos colgados a propósito

before(async () => {
  servidor = http.createServer((req, res) => {
    if (req.url === '/mudo') {
      // Acepta y NO responde nunca: el caso exacto del hallazgo.
      abiertas.push(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(() => {
  for (const res of abiertas) res.destroy();
  servidor.close();
});

test('una respuesta normal pasa igual que con fetch', async () => {
  const res = await fetchConDeadline(`${base}/ok`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, url: '/ok' });
});

test('un servidor que acepta y se calla da TimeoutError, no un cuelgue', async () => {
  await assert.rejects(
    () => fetchConDeadline(`${base}/mudo`, {}, { timeoutMs: 150 }),
    (err) => {
      assert.equal(err.name, 'TimeoutError');
      // El mensaje tiene que decir CUÁNTO esperó y CONTRA QUIÉN, o diagnosticarlo
      // cuesta una tarde ("The operation was aborted" no le sirve a nadie).
      assert.match(err.message, /timeout de 150ms/);
      assert.match(err.message, /127\.0\.0\.1/);
      return true;
    }
  );
});

test('el deadline no se come una respuesta que llega a tiempo', async () => {
  const res = await fetchConDeadline(`${base}/ok`, {}, { timeoutMs: 5000 });
  assert.equal(res.status, 200);
});

test('una señal propia del caller manda sobre el deadline', async () => {
  const ac = new AbortController();
  const p = fetchConDeadline(`${base}/mudo`, { signal: ac.signal }, { timeoutMs: 50 });
  setTimeout(() => ac.abort(), 120);
  await assert.rejects(p, (err) => {
    // Abortado por el caller a los ~120ms. Si el deadline de 50ms le hubiera pisado la
    // señal, esto habría fallado a los 50ms Y con el texto del timeout. El error del
    // caller sale CRUDO: re-etiquetarlo como "timeout de 50ms" sería inventar una causa.
    assert.equal(err.name, 'AbortError');
    assert.doesNotMatch(err.message, /timeout de/);
    return true;
  });
});

test('HTTP_TIMEOUT_MS: default 30s, configurable por env', () => {
  delete process.env.HTTP_TIMEOUT_MS;
  assert.equal(HTTP_TIMEOUT_MS(), 30000);
  process.env.HTTP_TIMEOUT_MS = '5000';
  assert.equal(HTTP_TIMEOUT_MS(), 5000);
  delete process.env.HTTP_TIMEOUT_MS;
});

// Los cuatro clientes de red tienen que estar usando el helper. Es un test de FUENTE
// porque importarlos de verdad arrastra deps nativas; lo que hay que impedir es que un
// `fetch(` pelado vuelva a entrar por la puerta de atrás en el próximo cliente.
test('ningún cliente de red llama fetch() pelado', async () => {
  const { readFileSync } = await import('node:fs');
  const clientes = [
    '../src/calendly/index.js',
    '../src/hubspot/client.js',
    '../src/sheets/client.js',
    '../src/stripe/client.js',
  ];
  for (const rel of clientes) {
    const fuente = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.doesNotMatch(fuente, /await fetch\(/, `${rel} tiene un fetch() sin deadline`);
    assert.match(fuente, /fetchConDeadline/, `${rel} no importa el helper`);
  }
});
