// test/sheets-metrics.test.js
// Cubre el formateo PURO de métricas (formatMetrics, layout "Resumen Semanal — Show
// rate por closer") y la resolución de destinatarios (resolveRecipients).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatMetrics } from '../src/sheets/metrics.js';
import { resolveRecipients } from '../src/scheduler/metrics-recipients.js';

const NOW = new Date('2026-06-18T22:00:00Z'); // 17:00 en Bogotá → 18/06/2026

// Filas como las devuelve la API de Sheets (sin celdas vacías al final de cada fila).
const HEADER = ['#', 'Closer', 'Agendados', 'Shows', 'Show Rate Total', 'Pushes 3/3', 'Shows 3/3', 'Show Rate 3/3', 'Shows <4', 'Show Rate <4', 'Delta', 'Interpretación'];
const REAL_ROWS = [
  ['RESUMEN SEMANAL — SHOW RATE POR CLOSER & EMPRESA'],
  ['Actualizar semana en celda D4 • Las fórmulas se calculan automáticamente'],
  [],
  ['Filtrar semana:', '', '2', '', '(Cambiar este número para ver semana 1, 2 o 3)'],
  [],
  ['30X'],
  HEADER,
  ['1', 'Pablo Lozano', '36', '13', '36.1%', '14', '10', '71.4%', '3', '13.6%', '+57.8%', 'Protocolo impacta show rate'],
  ['2', 'Juan Sebastian Salazar', '8', '6', '75.0%', '5', '4', '80.0%', '2', '66.7%', '+13.3%', 'Protocolo impacta show rate'],
  ['3', 'Maca Celis', '15', '0', '0.0%', '0', '0', '0.0%', '0', '0.0%', '0.0%', 'Muestra insuficiente'],
  [],
  ['ESTADOX'],
  HEADER,
  ['1', 'Juan Sebastian Salazar', '0', '0', '0.0%', '0', '0', '0.0%', '0', '0.0%', '0.0%', 'Sin datos'],
  ['2', 'Daniela Camacho', '0', '0', '0.0%', '0', '0', '0.0%', '0', '0.0%', '0.0%', 'Sin datos'],
];

// ─── formatMetrics (layout real) ──────────────────────────────────────────────

test('formatMetrics: encabezado + número de semana de "Filtrar semana"', () => {
  const out = formatMetrics(REAL_ROWS, { now: NOW });
  assert.match(out, /📈 Métricas semanales/);
  assert.match(out, /Semana 2/);
});

test('formatMetrics: secciones por empresa en negrita', () => {
  const out = formatMetrics(REAL_ROWS, { now: NOW });
  assert.match(out, /\*30X\*/);
  assert.match(out, /\*ESTADOX\*/);
});

test('formatMetrics: fila de closer con datos → shows/agendados + show rates + delta', () => {
  const out = formatMetrics(REAL_ROWS, { now: NOW });
  assert.match(out, /• Pablo Lozano — 13\/36 shows \(36\.1%\) · 3\/3: 71\.4% · <4: 13\.6% · Δ \+57\.8%/);
  assert.match(out, /• Juan Sebastian Salazar — 6\/8 shows \(75\.0%\) · 3\/3: 80\.0% · <4: 66\.7% · Δ \+13\.3%/);
});

test('formatMetrics: delta 0.0% se omite (Maca Celis, con agendados pero 0 shows)', () => {
  const out = formatMetrics(REAL_ROWS, { now: NOW });
  assert.match(out, /• Maca Celis — 0\/15 shows \(0\.0%\)/);
  assert.doesNotMatch(out, /Maca Celis.*Δ/); // delta 0.0% no se imprime
});

test('formatMetrics: closer 0 agendados y 0 shows → "sin datos"', () => {
  const out = formatMetrics(REAL_ROWS, { now: NOW });
  assert.match(out, /• Daniela Camacho — sin datos/);
});

test('formatMetrics: ignora filas de título/instrucciones', () => {
  const out = formatMetrics(REAL_ROWS, { now: NOW });
  assert.doesNotMatch(out, /RESUMEN SEMANAL —/); // la fila de título no se renderiza
  assert.doesNotMatch(out, /se calculan automáticamente/);
});

// ─── fallback genérico (estructura inesperada) ────────────────────────────────

test('formatMetrics: sin filas de closer → fallback genérico (filas no vacías)', () => {
  const out = formatMetrics([['Total ventas', '42'], ['Meta', '50']], { now: NOW });
  assert.match(out, /• Total ventas: 42/);
  assert.match(out, /• Meta: 50/);
});

test('formatMetrics: sin contenido → lo dice', () => {
  assert.match(formatMetrics([], { now: NOW }), /no hay métricas disponibles/i);
  assert.match(formatMetrics([['', '']], { now: NOW }), /no hay métricas disponibles/i);
});

// ─── resolveRecipients ────────────────────────────────────────────────────────

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('resolveRecipients: CSV parseado, "boss" → destino del jefe, sin duplicados', () => {
  withEnv(
    { SHEETS_METRICS_RECIPIENTS: 'boss, 158025419608301@lid , 158025419608301@lid', BOSS_LID: '144@lid', BOSS_PHONE: '' },
    () => {
      assert.deepEqual(resolveRecipients(), ['144@lid', '158025419608301@lid']);
    }
  );
});

test('resolveRecipients: "boss" cae al teléfono si no hay BOSS_LID', () => {
  withEnv({ SHEETS_METRICS_RECIPIENTS: 'boss', BOSS_LID: '', BOSS_PHONE: '573105643297' }, () => {
    assert.deepEqual(resolveRecipients(), ['573105643297']);
  });
});

test('resolveRecipients: vacío → lista vacía (job se autodesactiva)', () => {
  withEnv({ SHEETS_METRICS_RECIPIENTS: '' }, () => {
    assert.deepEqual(resolveRecipients(), []);
  });
});
