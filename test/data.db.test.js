// test/data.db.test.js — migración idempotente + recordatorios + memoria + resúmenes
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'sba-db-'));
const DB_PATH = join(dir, 'test.sqlite');
process.env.DB_PATH = DB_PATH;

let db;

before(async () => {
  // Migrar dos veces para comprobar idempotencia
  const env = { ...process.env, DB_PATH };
  execFileSync('node', ['src/db/migrate.js'], { env, stdio: 'pipe' });
  execFileSync('node', ['src/db/migrate.js'], { env, stdio: 'pipe' });
  db = await import('../src/db/index.js');
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('migración crea las tablas y columnas nuevas', () => {
  const def = db.default;
  const cols = def.prepare('PRAGMA table_info(reminders)').all().map((c) => c.name);
  for (const c of ['to_phone', 'created_by', 'status', 'sent_at']) assert.ok(cols.includes(c), `falta ${c}`);
  const tables = def
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((t) => t.name);
  for (const t of ['contacts', 'reminders', 'messages', 'memory', 'group_context']) {
    assert.ok(tables.includes(t), `falta tabla ${t}`);
  }
});

test('recordatorio con destinatario: save -> pending -> sent', () => {
  const past = '2000-01-01 09:00:00';
  db.saveReminder({ text: 'call con Juan', dueAt: past, toPhone: '573001112222', createdBy: 'jefe' });
  const pending = db.getPendingReminders();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].to_phone, '573001112222');
  assert.equal(pending[0].status, 'pending');

  db.markReminderSent(pending[0].id);
  assert.equal(db.getPendingReminders().length, 0);
});

test('getUpcomingReminders solo trae pendientes futuros en ventana', () => {
  const def = db.default;
  def.prepare(
    `INSERT INTO reminders (text, due_at, status) VALUES ('en 2h', datetime('now','+2 hours'), 'pending')`
  ).run();
  def.prepare(
    `INSERT INTO reminders (text, due_at, status) VALUES ('en 5 dias', datetime('now','+5 days'), 'pending')`
  ).run();
  const up = db.getUpcomingReminders(24);
  assert.ok(up.some((r) => r.text === 'en 2h'));
  assert.ok(!up.some((r) => r.text === 'en 5 dias'), 'no debe traer fuera de ventana');
});

test('memoria: set/get/getAll/search', () => {
  db.setMemory('numero_cuenta', '1234567');
  assert.equal(db.getMemory('numero_cuenta'), '1234567');
  db.setMemory('numero_cuenta', '7654321'); // upsert
  assert.equal(db.getMemory('numero_cuenta'), '7654321');
  assert.ok(db.getAllMemory().some((m) => m.key === 'numero_cuenta'));
  assert.ok(db.searchMemory('cuenta').length >= 1);
});

test('resúmenes: save y recuperación', () => {
  db.saveSummary({
    chatId: '123@g.us',
    chatName: 'Closers',
    summary: 'cerraron 3 deals esta semana',
    periodStart: '2026-06-01',
    periodEnd: '2026-06-03',
  });
  const recent = db.getRecentSummaries(5);
  assert.equal(recent[0].chat_name, 'Closers');
  assert.equal(recent[0].chat_id, '123@g.us');
  assert.ok(db.searchSummaries('deals').length >= 1);
});

test('dedup de webhooks: markIfNew', () => {
  assert.equal(db.markIfNew('msg-1'), true);
  assert.equal(db.markIfNew('msg-1'), false);
  assert.equal(db.markIfNew(null), true);
});
