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

// ─── isDraftDue / isGeneratedPublishDue (mensajes generados con aprobación) ────

test('isDraftDue: entra en ventana lead antes de la hora y sigue el resto del día', async () => {
  const { isDraftDue } = await import('../src/scheduler/recurring-logic.js');
  const base = { days: '4', timeHm: '09:00', leadMin: 60 };
  assert.equal(isDraftDue({ ...base, nowParts: { date: 'd', hm: '07:59', dow: 4 } }), false, 'antes del lead no');
  assert.equal(isDraftDue({ ...base, nowParts: { date: 'd', hm: '08:00', dow: 4 } }), true, 'al inicio del lead sí');
  assert.equal(isDraftDue({ ...base, nowParts: { date: 'd', hm: '11:00', dow: 4 } }), true, 'tarde el mismo día sí (bot caído)');
  assert.equal(isDraftDue({ ...base, nowParts: { date: 'd', hm: '08:30', dow: 5 } }), false, 'otro día no');
});

test('isGeneratedPublishDue: desde la hora en adelante, sin tope, hasta cambiar de día', async () => {
  const { isGeneratedPublishDue } = await import('../src/scheduler/recurring-logic.js');
  const base = { days: '4', timeHm: '09:00', lastSentDate: null };
  assert.equal(isGeneratedPublishDue({ ...base, nowParts: { date: 'd', hm: '08:59', dow: 4 } }), false);
  assert.equal(isGeneratedPublishDue({ ...base, nowParts: { date: 'd', hm: '09:00', dow: 4 } }), true);
  assert.equal(isGeneratedPublishDue({ ...base, nowParts: { date: 'd', hm: '17:45', dow: 4 } }), true, 'aprobación tardía publica');
  assert.equal(isGeneratedPublishDue({ ...base, lastSentDate: 'd', nowParts: { date: 'd', hm: '10:00', dow: 4 } }), false, 'ya publicado hoy');
  assert.equal(isGeneratedPublishDue({ ...base, nowParts: { date: 'd', hm: '10:00', dow: 5 } }), false, 'otro día no');
});

// ─── Override de un solo día (§18.AC: adelantar/atrasar UNA ocurrencia) ────────

test('override: el día del override dispara a la hora nueva, no a la normal', () => {
  const base = { days: '4', timeHm: '20:00', lastSentDate: null, overrideDate: '2026-06-11', overrideTime: '18:00' };
  // A la hora del override sí:
  assert.equal(isRecurringDue({ ...base, nowParts: { ...JUEVES_8PM, hm: '18:00' } }), true);
  // A la hora NORMAL de ese día no (ya no aplica: el jefe la movió):
  assert.equal(isRecurringDue({ ...base, nowParts: JUEVES_8PM }), false);
});

test('override: atrasar (hora nueva DESPUÉS de la normal) también anula la normal', () => {
  const base = { days: '4', timeHm: '20:00', lastSentDate: null, overrideDate: '2026-06-11', overrideTime: '21:30' };
  assert.equal(isRecurringDue({ ...base, nowParts: JUEVES_8PM }), false, 'a las 20:00 ya no');
  assert.equal(isRecurringDue({ ...base, nowParts: { ...JUEVES_8PM, hm: '21:30' } }), true, 'a las 21:30 sí');
});

test('override: aplica aunque el día no esté en days (el jefe lo movió a ese día)', () => {
  const viernes = { date: '2026-06-12', hm: '10:00', dow: 5 };
  assert.equal(
    isRecurringDue({ days: '0,4', timeHm: '20:00', lastSentDate: null, nowParts: viernes, overrideDate: '2026-06-12', overrideTime: '10:00' }),
    true
  );
});

test('override: en otras fechas todo sigue normal (override futuro o pasado es inerte)', () => {
  const base = { days: '4', timeHm: '20:00', lastSentDate: null, nowParts: JUEVES_8PM };
  assert.equal(isRecurringDue({ ...base, overrideDate: '2026-06-18', overrideTime: '18:00' }), true, 'override futuro no afecta hoy');
  assert.equal(isRecurringDue({ ...base, overrideDate: '2026-06-04', overrideTime: '18:00' }), true, 'override pasado inerte');
});

test('override: respeta el anti doble-envío (last_sent_date de hoy bloquea)', () => {
  assert.equal(
    isRecurringDue({
      days: '4', timeHm: '20:00', lastSentDate: '2026-06-11',
      nowParts: { ...JUEVES_8PM, hm: '18:05' }, overrideDate: '2026-06-11', overrideTime: '18:00',
    }),
    false
  );
});

test('override en isDraftDue/isGeneratedPublishDue: lead y publicación siguen la hora nueva', async () => {
  const { isDraftDue, isGeneratedPublishDue } = await import('../src/scheduler/recurring-logic.js');
  const ov = { overrideDate: 'd', overrideTime: '07:00' };
  // Draft: lead de 60 min ANTES de la hora del override (07:00), no de la normal (09:00).
  assert.equal(isDraftDue({ days: '4', timeHm: '09:00', leadMin: 60, nowParts: { date: 'd', hm: '06:00', dow: 4 }, ...ov }), true);
  assert.equal(isDraftDue({ days: '4', timeHm: '09:00', leadMin: 60, nowParts: { date: 'd', hm: '05:59', dow: 4 }, ...ov }), false);
  // Publicación: desde la hora del override.
  assert.equal(isGeneratedPublishDue({ days: '4', timeHm: '09:00', lastSentDate: null, nowParts: { date: 'd', hm: '07:00', dow: 4 }, ...ov }), true);
  assert.equal(isGeneratedPublishDue({ days: '4', timeHm: '09:00', lastSentDate: null, nowParts: { date: 'd', hm: '06:59', dow: 4 }, ...ov }), false);
});

test('isOutreachDue daily: pasa el override de la fila (adelantado dispara, hora normal no)', async () => {
  const { isOutreachDue } = await import('../src/scheduler/recurring-logic.js');
  const row = {
    recur_kind: 'daily', days: '4', time_hm: '17:00', last_sent_date: null,
    override_date: '2026-06-11', override_time: '15:00',
  };
  const at = (hm) => ({ nowStamp: `2026-06-11 ${hm}:00`, nowParts: { date: '2026-06-11', hm, dow: 4 } });
  assert.equal(isOutreachDue(row, at('15:00')), true, 'a la hora del override sí');
  assert.equal(isOutreachDue(row, at('17:00')), false, 'a la hora normal ya no');
});

test('effectiveTimeHm: hora del override solo el día que aplica', async () => {
  const { effectiveTimeHm } = await import('../src/scheduler/recurring-logic.js');
  assert.equal(effectiveTimeHm({ timeHm: '20:00', overrideDate: 'd', overrideTime: '18:00' }, { date: 'd' }), '18:00');
  assert.equal(effectiveTimeHm({ timeHm: '20:00', overrideDate: 'otro', overrideTime: '18:00' }, { date: 'd' }), '20:00');
  assert.equal(effectiveTimeHm({ timeHm: '20:00' }, { date: 'd' }), '20:00');
});
