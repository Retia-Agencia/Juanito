// test/data.reminders.test.js — selección texto vs template
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'sba-rem-')), 'test.sqlite');

let selectDelivery;
before(async () => {
  ({ selectDelivery } = await import('../src/scheduler/reminders.js'));
});

const BOSS = '573001234567';

test('jefe dentro de ventana -> texto', () => {
  assert.equal(selectDelivery({ toPhone: null, bossPhone: BOSS, bossInWindow: true }), 'text');
});

test('jefe fuera de ventana -> template', () => {
  assert.equal(selectDelivery({ toPhone: null, bossPhone: BOSS, bossInWindow: false }), 'template');
});

test('to_phone que es el jefe (con formato) dentro de ventana -> texto', () => {
  assert.equal(
    selectDelivery({ toPhone: '+57 300 123 4567', bossPhone: BOSS, bossInWindow: true }),
    'text'
  );
});

test('tercero siempre -> template (aunque la ventana del jefe esté abierta)', () => {
  assert.equal(
    selectDelivery({ toPhone: '573009998888', bossPhone: BOSS, bossInWindow: true }),
    'template'
  );
});
