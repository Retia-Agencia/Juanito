// test/sheets-metrics.test.js
// Cubre el formateo PURO de métricas (formatMetrics: completo y por empresa) y el
// mapeo sección→grupo (sectionTargets).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatMetrics } from '../src/sheets/metrics.js';
import { sectionTargets } from '../src/scheduler/metrics-targets.js';

const NOW = new Date('2026-06-18T22:00:00Z'); // 17:00 en Bogotá → 18/06/2026

const HEADER = ['#', 'Closer', 'Agendados', 'Shows', 'Show Rate Total', 'Pushes 3/3', 'Shows 3/3', 'Show Rate 3/3', 'Shows <4', 'Show Rate <4', 'Delta', 'Interpretación'];
const ROWS = [
  ['RESUMEN DIARIO — SHOW RATE POR CLOSER & EMPRESA'],
  ['Día:', '6/18/26'],
  [],
  ['30X'],
  HEADER,
  ['1', 'Pablo Lozano', '12', '4', '33.3%', '3', '2', '66.7%', '2', '0.0%', '+66.7%', 'Protocolo impacta show rate'],
  ['2', 'Maca Celis', '0', '0', '0.0%', '0', '0', '0.0%', '0', '0.0%', '0.0%', 'Sin datos'],
  [],
  ['ESTADOX'],
  HEADER,
  ['1', 'Daniela Camacho', '5', '3', '60.0%', '2', '2', '100.0%', '1', '33.3%', '+66.7%', 'Protocolo impacta show rate'],
];

// ─── formatMetrics: completo ──────────────────────────────────────────────────

test('formatMetrics completo: ambas secciones en negrita + sus closers', () => {
  const out = formatMetrics(ROWS, { now: NOW });
  assert.match(out, /📈 Métricas/);
  assert.match(out, /\*30X\*/);
  assert.match(out, /\*ESTADOX\*/);
  assert.match(out, /• Pablo Lozano — 4\/12 shows \(33\.3%\) · 3\/3: 66\.7% · <4: 0\.0% · Δ \+66\.7%/);
  assert.match(out, /• Daniela Camacho — 3\/5 shows \(60\.0%\)/);
});

// ─── formatMetrics: por empresa (una sección → un grupo) ──────────────────────

test('formatMetrics company=30X: SOLO la sección 30X, título con la empresa', () => {
  const out = formatMetrics(ROWS, { now: NOW, company: '30X' });
  assert.match(out, /📈 Métricas del día — 30X/);
  assert.match(out, /• Pablo Lozano/);
  assert.match(out, /• Maca Celis — sin datos/);
  assert.doesNotMatch(out, /Daniela Camacho/); // nada de ESTADOX
  assert.doesNotMatch(out, /\*ESTADOX\*/);
});

test('formatMetrics company=ESTADOX: SOLO la sección ESTADOX', () => {
  const out = formatMetrics(ROWS, { now: NOW, company: 'ESTADOX' });
  assert.match(out, /— ESTADOX/);
  assert.match(out, /• Daniela Camacho/);
  assert.doesNotMatch(out, /Pablo Lozano/);
});

test('formatMetrics company inexistente → lo dice', () => {
  assert.match(formatMetrics([['30X'], HEADER], { now: NOW, company: 'ESTADOX' }), /no hay métricas para ESTADOX/i);
});

test('formatMetrics: sin contenido → fallback lo dice', () => {
  assert.match(formatMetrics([], { now: NOW }), /no hay métricas disponibles/i);
});

// ─── sectionTargets ───────────────────────────────────────────────────────────

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

test('sectionTargets: mapea cada empresa a su grupo configurado', () => {
  withEnv(
    { SHEETS_METRICS_30X_GROUP: 'Closers Second Brain', SHEETS_METRICS_ESTADOX_GROUP: 'Closers IA para Abogados' },
    () => {
      assert.deepEqual(sectionTargets(), [
        { company: '30X', group: 'Closers Second Brain' },
        { company: 'ESTADOX', group: 'Closers IA para Abogados' },
      ]);
    }
  );
});

test('sectionTargets: omite las secciones sin grupo', () => {
  withEnv({ SHEETS_METRICS_30X_GROUP: 'Closers Second Brain', SHEETS_METRICS_ESTADOX_GROUP: '' }, () => {
    assert.deepEqual(sectionTargets(), [{ company: '30X', group: 'Closers Second Brain' }]);
  });
});

test('sectionTargets: sin nada configurado → vacío (job se autodesactiva)', () => {
  withEnv({ SHEETS_METRICS_30X_GROUP: '', SHEETS_METRICS_ESTADOX_GROUP: '' }, () => {
    assert.deepEqual(sectionTargets(), []);
  });
});
