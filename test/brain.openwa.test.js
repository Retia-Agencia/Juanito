// test/brain.openwa.test.js
// Resolución de grupo por nombre (alimenta summarize_group). Runner: `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGroupByName } from '../src/openwa/index.js';

const GROUPS = [
  { id: '1@g.us', name: 'Proveedores' },
  { id: '2@g.us', name: 'Familia' },
  { id: '3@g.us', name: 'Equipo Ventas' },
];

test('match exacto (case-insensitive)', async () => {
  const g = await resolveGroupByName('familia', GROUPS);
  assert.equal(g.id, '2@g.us');
});

test('match parcial', async () => {
  const g = await resolveGroupByName('ventas', GROUPS);
  assert.equal(g.id, '3@g.us');
});

test('exacto gana sobre parcial', async () => {
  const list = [
    { id: 'a', name: 'Proveedores Internacionales' },
    { id: 'b', name: 'Proveedores' },
  ];
  const g = await resolveGroupByName('Proveedores', list);
  assert.equal(g.id, 'b');
});

test('sin coincidencia devuelve null', async () => {
  assert.equal(await resolveGroupByName('inexistente', GROUPS), null);
});

test('nombre vacío devuelve null', async () => {
  assert.equal(await resolveGroupByName('', GROUPS), null);
});
