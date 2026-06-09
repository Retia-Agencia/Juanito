// test/data.calendly-pushes.test.js
// Tests del SQL real de los pushes de Calendly (claim atómico, revert,
// reschedule-from-sent del bug #2). REQUIERE better-sqlite3 nativo → corre en
// Docker/VPS, no en node 26 local. La lógica de decisión pura está cubierta
// además en test/calendly.push-logic.test.js (corre en cualquier lado).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'cal-push-'));
const DB_PATH = join(dir, 'test.sqlite');
process.env.DB_PATH = DB_PATH;

let db;

before(async () => {
  execFileSync('node', ['src/db/migrate.js'], { env: { ...process.env, DB_PATH }, stdio: 'pipe' });
  db = await import('../src/db/index.js');
});

after(() => rmSync(dir, { recursive: true, force: true }));

const base = (over = {}) => ({
  event_uuid: 'evt-1',
  push_n: 3,
  closer_email: 'sebastian.salazar@30x.com',
  closer_phone: '+573054312905',
  prospect_name: 'Juan Pérez',
  prospect_phone: '+57 300 111 2222',
  call_start: '2026-06-10 20:30:00',
  due_at: '2026-06-10 20:05:00',
  message: 'Push 3 …',
  ...over,
});

test('scheduleCalendlyPush: insert → new, repetido sin cambio → unchanged', () => {
  assert.equal(db.scheduleCalendlyPush(base()), 'new');
  assert.equal(db.scheduleCalendlyPush(base()), 'unchanged');
});

test('claim atómico: solo el primer claim gana; revert lo devuelve a scheduled', () => {
  db.scheduleCalendlyPush(base({ event_uuid: 'evt-claim' }));
  const row = db.default.prepare(`SELECT id FROM calendly_pushes WHERE event_uuid='evt-claim'`).get();
  assert.equal(db.claimCalendlyPush(row.id), true, 'primer claim gana');
  assert.equal(db.claimCalendlyPush(row.id), false, 'segundo claim pierde (ya sending)');
  db.revertCalendlyPush(row.id);
  assert.equal(db.claimCalendlyPush(row.id), true, 'tras revert vuelve a poder reclamarse');
});

test('bug #2: reagenda a futuro tras sent → reschedule + status vuelve a scheduled', () => {
  db.scheduleCalendlyPush(base({ event_uuid: 'evt-resched' }));
  const id = db.default.prepare(`SELECT id FROM calendly_pushes WHERE event_uuid='evt-resched'`).get().id;
  db.markCalendlyPushSent(id);
  assert.equal(db.default.prepare(`SELECT status FROM calendly_pushes WHERE id=?`).get(id).status, 'sent');

  // Reagendada lejos en el futuro (due futuro respecto a "ahora")
  const future = new Date(Date.now() + 3 * 3600 * 1000);
  const sq = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  const r = db.scheduleCalendlyPush(
    base({ event_uuid: 'evt-resched', call_start: sq(future), due_at: sq(new Date(future.getTime() - 25 * 60000)) })
  );
  assert.equal(r, 'rescheduled');
  const after = db.default.prepare(`SELECT status, sent_at FROM calendly_pushes WHERE id=?`).get(id);
  assert.equal(after.status, 'scheduled', 're-armado');
  assert.equal(after.sent_at, null, 'sent_at limpiado');
});

test('getDueCalendlyPushes: solo scheduled con due <= now', () => {
  // due en el pasado → aparece; una con due futuro no debe aparecer.
  db.scheduleCalendlyPush(base({ event_uuid: 'evt-due-past', due_at: '2000-01-01 00:00:00', call_start: '2000-01-01 00:25:00' }));
  db.scheduleCalendlyPush(base({ event_uuid: 'evt-due-future', due_at: '2999-01-01 00:00:00', call_start: '2999-01-01 00:25:00' }));
  const due = db.getDueCalendlyPushes();
  const uuids = due.map((d) => d.event_uuid);
  assert.ok(uuids.includes('evt-due-past'));
  assert.ok(!uuids.includes('evt-due-future'));
});
