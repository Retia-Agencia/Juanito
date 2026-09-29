// test/data.wa-outbound.test.js — registro de envíos de WhatsApp y sus recibos (§18.CC)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'sba-wa-outbound-'));
const DB_PATH = join(dir, 'test.sqlite');
process.env.DB_PATH = DB_PATH;

let data;
const row = (id) => data.default.prepare(`SELECT * FROM wa_outbound WHERE msg_id = ?`).get(id);

before(async () => {
  execFileSync('node', ['src/db/migrate.js'], { env: { ...process.env, DB_PATH }, stdio: 'pipe' });
  data = await import('../src/db/index.js');
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('un envío nace como sent, con su tag y su closer', () => {
  data.recordWaOutbound({ msgId: 'A1', jid: '1@lid', tag: 'push1', ref: 'registro@ttrading.co' });
  const r = row('A1');
  assert.equal(r.status, 'sent');
  assert.equal(r.status_rank, 1);
  assert.equal(r.tag, 'push1');
  assert.equal(r.ref, 'registro@ttrading.co');
});

test('los recibos solo suben: un delivered tardío no pisa un read', () => {
  data.recordWaOutbound({ msgId: 'A2', jid: '1@lid' });
  data.updateWaOutboundStatus('A2', 3);
  data.updateWaOutboundStatus('A2', 4);
  assert.equal(data.updateWaOutboundStatus('A2', 3), 0);
  assert.equal(row('A2').status, 'read');
});

test('un rechazo del servidor se registra siempre, con su código', () => {
  data.recordWaOutbound({ msgId: 'A3', jid: '1@lid' });
  data.updateWaOutboundStatus('A3', 3);
  data.updateWaOutboundStatus('A3', 0, '463');
  const r = row('A3');
  assert.equal(r.status, 'error');
  assert.equal(r.error, '463');
});

test('un reintento devuelve el mensaje original y queda contado', () => {
  const msg = Buffer.from([1, 2, 3]);
  data.recordWaOutbound({ msgId: 'A4', jid: '1@lid', tag: 'push2', message: msg });
  const got = data.takeWaOutboundForRetry('A4');
  assert.deepEqual(Buffer.from(got.message), msg);
  assert.equal(got.tag, 'push2');
  assert.equal(row('A4').retries, 1);
  assert.equal(data.takeWaOutboundForRetry('no-existe'), null);
});

test('la limpieza vacía el contenido a los 2 días y borra la fila al mes', () => {
  data.recordWaOutbound({ msgId: 'V1', jid: '1@lid', message: Buffer.from([9]) });
  data.recordWaOutbound({ msgId: 'V2', jid: '1@lid', message: Buffer.from([9]) });
  data.default.prepare(`UPDATE wa_outbound SET sent_at = datetime('now', '-3 days') WHERE msg_id = 'V1'`).run();
  data.default.prepare(`UPDATE wa_outbound SET sent_at = datetime('now', '-31 days') WHERE msg_id = 'V2'`).run();
  data.cleanup();
  assert.equal(row('V1').message, null);
  assert.equal(row('V2'), undefined);
});
