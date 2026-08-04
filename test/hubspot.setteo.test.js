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

// ─── Brecha reportado vs. HubSpot (§18.AZ) ────────────────────────────────────

test('format: sin `reportado` el bloque sale como antes', () => {
  const agg = aggregateSetteos([{ ownerId: '1', esCall: false }, { ownerId: '2', esCall: false }], OWNERS);
  const txt = formatSetteoBlock(agg, { dateLabel: 'hoy' });
  assert.match(txt, /\*Sebastian Rodriguez\* — 1 setteo/);
  assert.doesNotMatch(txt, /reportados/);
});

test('format: con `reportado` muestra las dos cifras y marca la brecha', () => {
  const agg = aggregateSetteos([{ ownerId: '1', esCall: false }, { ownerId: '1', esCall: false }], OWNERS);
  const txt = formatSetteoBlock(agg, { dateLabel: 'hoy', reportado: { 'Sebastian Rodriguez': 15 } });
  assert.match(txt, /\*Sebastian Rodriguez\* — 15 reportados \/ 2 en HubSpot/);
  assert.match(txt, /⚠️ 13 sin registrar/);
});

test('format: sin brecha no se marca la advertencia', () => {
  const agg = aggregateSetteos([{ ownerId: '2', esCall: false }], OWNERS);
  const txt = formatSetteoBlock(agg, { reportado: { 'Pablo Lozano': 1 } });
  assert.match(txt, /1 reportado \/ 1 en HubSpot/);
  assert.doesNotMatch(txt, /⚠️/, 'sin brecha no hay nada que marcar');
});

// El caso MÁS informativo: reportó gestión y no hay nada en el CRM. Si solo se listaran los
// closers del agregado de HubSpot, este desaparecería justo cuando hay que verlo.
test('format: un closer que reportó y NO registró nada igual aparece', () => {
  const txt = formatSetteoBlock(aggregateSetteos([], OWNERS), { reportado: { 'Pablo Lozano': 11 } });
  assert.ok(txt, 'no puede devolver null: hay algo que reportar');
  assert.match(txt, /\*Pablo Lozano\* — 11 reportados \/ 0 en HubSpot/);
  assert.match(txt, /⚠️ 11 sin registrar/);
});

// La brecha admite dos lecturas y el dato no distingue. Afirmar una sería fabricar una
// conclusión, y esto va al DM del jefe.
test('format: el pie explica la ambigüedad de la brecha, sin acusar a nadie', () => {
  const agg = aggregateSetteos([{ ownerId: '1', esCall: false }], OWNERS);
  const txt = formatSetteoBlock(agg, { reportado: { 'Sebastian Rodriguez': 9 } });
  assert.match(txt, /gestión sin registrar o reporte inflado/);
  assert.match(txt, /dependen las comisiones/);
});

test('format: sin datos de ningún lado sigue devolviendo null', () => {
  assert.equal(formatSetteoBlock(aggregateSetteos([], OWNERS), { reportado: {} }), null);
  assert.equal(formatSetteoBlock(null, {}), null);
});
