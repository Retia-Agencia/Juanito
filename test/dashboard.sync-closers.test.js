// test/dashboard.sync-closers.test.js — envío de call_outcomes al Dashboard de Closers de 30X.
//
// Lo que se fija: (1) solo salen programas de 30X, (2) las fechas UTC sin zona salen con Z
// (si no, Postgres las corre por la zona del servidor), (3) no viajan teléfonos ni texto
// crudo, (4) el envío va en lotes con secreto y falla fuerte ante un no-2xx.
//
// Corre en Windows: el módulo solo importa la DB dentro de start().
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  programas30x,
  utcIso,
  filaParaDashboard,
  syncConfigurado,
  enviar,
} from '../dashboard/server/sync-closers.js';

const fetchReal = globalThis.fetch;

beforeEach(() => {
  process.env.CLOSERS_SYNC_URL = 'https://ejemplo.supabase.co/';
  process.env.CLOSERS_SYNC_KEY = 'llave-publicable';
  process.env.CLOSERS_SYNC_SECRET = 'secreto';
});

afterEach(() => {
  globalThis.fetch = fetchReal;
  delete process.env.CLOSERS_SYNC_URL;
  delete process.env.CLOSERS_SYNC_KEY;
  delete process.env.CLOSERS_SYNC_SECRET;
});

test('solo programas de 30X', () => {
  const p = programas30x();
  for (const k of ['second_brain', 'developers', 'operaciones', 'instagram']) assert.ok(p.includes(k), k);
  for (const k of ['abogados', 'tactical_investor', 'comunicarte', 'powertalk']) assert.ok(!p.includes(k), k);
});

test('utcIso agrega la Z a las fechas UTC sin zona y respeta las demás', () => {
  assert.equal(utcIso('2026-10-01 15:00:00'), '2026-10-01T15:00:00Z');
  assert.equal(utcIso('2026-10-01T15:00:00Z'), '2026-10-01T15:00:00Z');
  assert.equal(utcIso(null), null);
});

test('la fila no lleva teléfonos ni texto crudo', () => {
  const f = filaParaDashboard({
    event_uuid: 'u1', program: 'second_brain', closer_email: 'a@30x.com', closer_name: 'A',
    closer_phone: '573000000000', lead_name: 'Lead', lead_phone: '573111111111',
    call_start: '2026-10-01 15:00:00', asistencia: 'show', resultado: 'venta_cerrada',
    status: 'answered', answered_at: '2026-10-01 16:10:00', raw_reply: 'cerró!',
  });
  assert.equal(f.call_start, '2026-10-01T15:00:00Z');
  assert.equal(f.answered_at, '2026-10-01T16:10:00Z');
  for (const k of ['closer_phone', 'lead_phone', 'raw_reply']) assert.ok(!(k in f), k);
});

test('sin las tres variables queda apagado', () => {
  assert.equal(syncConfigurado(), true);
  delete process.env.CLOSERS_SYNC_SECRET;
  assert.equal(syncConfigurado(), false);
});

test('envía en lotes de 500 a la RPC con llave y secreto', async () => {
  const llamadas = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    llamadas.push({ url, apikey: init.headers.apikey, secreto: body.secreto, n: body.filas.length });
    return new Response(String(body.filas.length), { status: 200 });
  };
  const filas = Array.from({ length: 1201 }, (_, i) => ({ event_uuid: `u${i}` }));
  assert.equal(await enviar(filas), 1201);
  assert.deepEqual(llamadas.map((l) => l.n), [500, 500, 201]);
  assert.equal(llamadas[0].url, 'https://ejemplo.supabase.co/rest/v1/rpc/ingest_juanito');
  assert.equal(llamadas[0].apikey, 'llave-publicable');
  assert.equal(llamadas[0].secreto, 'secreto');
});

test('una respuesta no-2xx corta el envío con el error', async () => {
  globalThis.fetch = async () => new Response('{"message":"no autorizado"}', { status: 401 });
  await assert.rejects(enviar([{ event_uuid: 'u1' }]), /ingest_juanito → 401/);
});
