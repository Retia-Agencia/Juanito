// Tests PUROS del conteo de setteos (src/hubspot/setteo.js): agregación por closer y formato.
// Sin red ni DB → corren en cualquier lado. Usan emails REALES del roster (closers.js) para
// ejercitar resolveCloser/isIgnoredCloser de verdad.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSetteos, formatSetteoBlock } from '../src/hubspot/setteo.js';

// ownerId → email. sebastian/pablo están en el roster; maca.celis está IGNORADO; maximo NO existe.
const OWNERS = {
  1: 'sebastian@30x.com', // Sebastian Rodriguez
  2: 'pablo.lozano@30x.com', // Pablo Lozano
  3: 'maca.celis@30x.com', // ignorado (salió del equipo)
  4: 'maximo@30x.com', // no está en el roster → sin mapear
};

test('aggregate: cuenta 1 por contacto tocado sin cita, por closer', () => {
  const contacts = [
    { ownerId: '1', esCall: false },
    { ownerId: '1', esCall: false },
    { ownerId: '2', esCall: false },
  ];
  const { porCloser } = aggregateSetteos(contacts, OWNERS);
  assert.deepEqual(porCloser, [
    { name: 'Sebastian Rodriguez', setteos: 2 },
    { name: 'Pablo Lozano', setteos: 1 },
  ]);
});

test('aggregate: los leads de call (esCall) NO cuentan como setteo', () => {
  const contacts = [
    { ownerId: '1', esCall: true },
    { ownerId: '1', esCall: true },
    { ownerId: '1', esCall: false },
  ];
  const { porCloser, calls } = aggregateSetteos(contacts, OWNERS);
  assert.deepEqual(porCloser, [{ name: 'Sebastian Rodriguez', setteos: 1 }]);
  assert.equal(calls, 2);
});

test('aggregate: owner ignorado → ignorados, no aparece', () => {
  const contacts = [{ ownerId: '3', esCall: false }];
  const { porCloser, ignorados } = aggregateSetteos(contacts, OWNERS);
  assert.equal(porCloser.length, 0);
  assert.equal(ignorados, 1);
});

test('aggregate: owner fuera del roster → sinMapear (no se descarta en silencio)', () => {
  const contacts = [
    { ownerId: '4', esCall: false },
    { ownerId: '99', esCall: false }, // ownerId sin email en el mapa
  ];
  const { porCloser, sinMapear } = aggregateSetteos(contacts, OWNERS);
  assert.equal(porCloser.length, 0);
  assert.equal(sinMapear, 2);
});

test('aggregate: orden por conteo desc, desempate alfabético', () => {
  const contacts = [
    { ownerId: '2', esCall: false },
    { ownerId: '2', esCall: false },
    { ownerId: '1', esCall: false },
    { ownerId: '1', esCall: false },
  ];
  const { porCloser } = aggregateSetteos(contacts, OWNERS);
  // Empate 2-2 → alfabético: Pablo antes que Sebastian.
  assert.deepEqual(porCloser, [
    { name: 'Pablo Lozano', setteos: 2 },
    { name: 'Sebastian Rodriguez', setteos: 2 },
  ]);
});

test('format: null cuando no hay setteos ni sin-mapear', () => {
  const agg = aggregateSetteos([{ ownerId: '1', esCall: true }], OWNERS);
  assert.equal(formatSetteoBlock(agg, { dateLabel: 'lun 22 jul' }), null);
});

test('format: incluye header, línea por closer y total', () => {
  const agg = aggregateSetteos(
    [
      { ownerId: '1', esCall: false },
      { ownerId: '1', esCall: false },
      { ownerId: '2', esCall: false },
    ],
    OWNERS
  );
  const txt = formatSetteoBlock(agg, { dateLabel: 'lun 22 jul' });
  assert.match(txt, /Setteo \(backlog\) — lun 22 jul/);
  assert.match(txt, /3 setteos/);
  assert.match(txt, /\*Sebastian Rodriguez\* — 2 setteos/);
  assert.match(txt, /\*Pablo Lozano\* — 1 setteo/);
});

test('format: muestra la línea sin-mapear cuando la hay', () => {
  const agg = aggregateSetteos([{ ownerId: '4', esCall: false }], OWNERS);
  const txt = formatSetteoBlock(agg, { dateLabel: 'hoy' });
  assert.match(txt, /sin mapear/);
});

test('format: singular/plural correcto (1 setteo)', () => {
  const agg = aggregateSetteos([{ ownerId: '1', esCall: false }], OWNERS);
  const txt = formatSetteoBlock(agg, {});
  assert.match(txt, /1 setteo\b/);
  assert.doesNotMatch(txt, /1 setteos/);
});
