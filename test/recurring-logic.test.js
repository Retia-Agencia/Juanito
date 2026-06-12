// test/recurring-logic.test.js
// Tests PUROS de la lógica de mensajes recurrentes a grupos (sin DB, sin timers).
// Corre nativo en Windows: node --test test/recurring-logic.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dayNameToNumber,
  daysToCsv,
  csvToDayLabels,
  normalizeTimeHm,
  zonedNowParts,
  isRecurringDue,
} from '../src/scheduler/recurring-logic.js';

// ─── Parsing de días y hora ────────────────────────────────────────────────────

test('dayNameToNumber: acepta con y sin tilde, case-insensitive', () => {
  assert.equal(dayNameToNumber('jueves'), 4);
  assert.equal(dayNameToNumber('Domingo'), 0);
  assert.equal(dayNameToNumber('miércoles'), 3);
  assert.equal(dayNameToNumber('miercoles'), 3);
  assert.equal(dayNameToNumber('SÁBADO'), 6);
  assert.equal(dayNameToNumber('feriado'), null);
  assert.equal(dayNameToNumber(''), null);
});

test('daysToCsv: ordena, deduplica y rechaza inválidos', () => {
  assert.equal(daysToCsv(['jueves', 'domingo']), '0,4');
  assert.equal(daysToCsv(['domingo', 'jueves', 'jueves']), '0,4');
  assert.equal(daysToCsv(['lunes']), '1');
  assert.equal(daysToCsv(['jueves', 'navidad']), null, 'un día inválido invalida todo');
  assert.equal(daysToCsv([]), null);
  assert.equal(daysToCsv(null), null);
});

test('csvToDayLabels: legible para confirmaciones', () => {
  assert.equal(csvToDayLabels('4'), 'jueves');
  assert.equal(csvToDayLabels('0,4'), 'domingo y jueves');
  assert.equal(csvToDayLabels('1,3,5'), 'lunes, miércoles y viernes');
});

test('normalizeTimeHm: normaliza a HH:MM y rechaza inválidas', () => {
  assert.equal(normalizeTimeHm('20:00'), '20:00');
  assert.equal(normalizeTimeHm('8:05'), '08:05');
  assert.equal(normalizeTimeHm('00:00'), '00:00');
  assert.equal(normalizeTimeHm('24:00'), null);
  assert.equal(normalizeTimeHm('20:60'), null);
  assert.equal(normalizeTimeHm('8pm'), null);
  assert.equal(normalizeTimeHm(''), null);
});

// ─── zonedNowParts ────────────────────────────────────────────────────────────

test('zonedNowParts: jueves 8pm Bogotá desde un instante UTC', () => {
  // 2026-06-11 fue jueves. 20:00 Bogotá = 01:00 UTC del día siguiente.
  const parts = zonedNowParts(new Date('2026-06-12T01:00:00Z'), 'America/Bogota');
  assert.equal(parts.date, '2026-06-11');
  assert.equal(parts.hm, '20:00');
  assert.equal(parts.dow, 4); // jueves
});

test('zonedNowParts: medianoche no produce hora 24', () => {
  // 00:30 Bogotá = 05:30 UTC
  const parts = zonedNowParts(new Date('2026-06-11T05:30:00Z'), 'America/Bogota');
  assert.equal(parts.hm, '00:30');
});

// ─── isRecurringDue ───────────────────────────────────────────────────────────

const JUEVES_8PM = { date: '2026-06-11', hm: '20:00', dow: 4 };

test('due: día y hora exactos, sin envío previo hoy', () => {
  assert.equal(
    isRecurringDue({ days: '0,4', timeHm: '20:00', lastSentDate: null, nowParts: JUEVES_8PM }),
    true
  );
});

test('due: dentro de la ventana de catch-up (bot reiniciando a la hora exacta)', () => {
  const parts = { ...JUEVES_8PM, hm: '20:14' };
  assert.equal(
    isRecurringDue({ days: '4', timeHm: '20:00', lastSentDate: null, nowParts: parts, windowMin: 30 }),
    true
  );
});

test('NO due: fuera de la ventana (demasiado tarde)', () => {
  const parts = { ...JUEVES_8PM, hm: '20:30' };
  assert.equal(
    isRecurringDue({ days: '4', timeHm: '20:00', lastSentDate: null, nowParts: parts, windowMin: 30 }),
    false
  );
});

test('NO due: antes de la hora', () => {
  const parts = { ...JUEVES_8PM, hm: '19:59' };
  assert.equal(isRecurringDue({ days: '4', timeHm: '20:00', lastSentDate: null, nowParts: parts }), false);
});

test('NO due: día que no está en la lista', () => {
  const viernes = { date: '2026-06-12', hm: '20:00', dow: 5 };
  assert.equal(isRecurringDue({ days: '0,4', timeHm: '20:00', lastSentDate: null, nowParts: viernes }), false);
});

test('NO due: ya se envió hoy (anti doble-envío dentro de la ventana)', () => {
  const parts = { ...JUEVES_8PM, hm: '20:05' };
  assert.equal(
    isRecurringDue({ days: '4', timeHm: '20:00', lastSentDate: '2026-06-11', nowParts: parts }),
    false
  );
});

test('due otra vez la semana siguiente (last_sent_date es de la semana pasada)', () => {
  assert.equal(
    isRecurringDue({ days: '4', timeHm: '20:00', lastSentDate: '2026-06-04', nowParts: JUEVES_8PM }),
    true
  );
});
