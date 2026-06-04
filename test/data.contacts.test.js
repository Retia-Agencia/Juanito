// test/data.contacts.test.js — directorio de contactos y resolución
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'sba-contacts-'));
const DB_PATH = join(dir, 'test.sqlite');
process.env.DB_PATH = DB_PATH;

let contacts;

before(async () => {
  execFileSync('node', ['src/db/migrate.js'], { env: { ...process.env, DB_PATH }, stdio: 'pipe' });
  contacts = await import('../src/contacts/index.js');
  contacts.upsertContact({ name: 'Juan', phone: '+57 300 111 2222' });
  contacts.upsertContact({ name: 'Juana', phone: '573004445555' });
  contacts.upsertContact({ name: 'Pedro', phone: '573009998888' });
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('upsert normaliza el teléfono', () => {
  const list = contacts.listContacts();
  const juan = list.find((c) => c.name === 'Juan');
  assert.equal(juan.phone, '573001112222');
});

test('resuelve por nombre exacto', () => {
  const r = contacts.resolveContact('Pedro');
  assert.equal(r.phone, '573009998888');
});

test('resuelve case-insensitive', () => {
  assert.equal(contacts.resolveContact('pedro').name, 'Pedro');
});

test('nombre ambiguo devuelve null', () => {
  // "Jua" matchea Juan y Juana -> ambiguo
  assert.equal(contacts.resolveContact('Jua'), null);
});

test('resuelve por número guardado', () => {
  const r = contacts.resolveContact('+57 300 111 2222');
  assert.equal(r.name, 'Juan');
});

test('número crudo no guardado se devuelve igual para poder enviar', () => {
  const r = contacts.resolveContact('57 320 000 0000');
  assert.equal(r.name, null);
  assert.equal(r.phone, '573200000000');
});

test('desconocido devuelve null', () => {
  assert.equal(contacts.resolveContact('Mengano'), null);
});
