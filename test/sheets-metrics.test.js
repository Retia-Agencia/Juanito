// test/sheets-metrics.test.js
// Cubre el formateo PURO de métricas (formatMetrics) y la resolución de
// destinatarios (resolveRecipients). Runner nativo: `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatMetrics } from '../src/sheets/metrics.js';
import { resolveRecipients } from '../src/scheduler/metrics-recipients.js';

const NOW = new Date('2026-06-18T22:00:00Z'); // 17:00 en Bogotá → 18/06/2026

// ─── formatMetrics ────────────────────────────────────────────────────────────

test('formatMetrics: encabezado + fecha del día (Bogotá)', () => {
  const out = formatMetrics([['Ventas', '10']], { now: NOW });
  assert.match(out, /📈 Métricas de desempeño/);
  assert.match(out, /18\/06\/2026/);
});

test('formatMetrics: fila de 2 celdas → "• etiqueta: valor"', () => {
  const out = formatMetrics([['Llamadas agendadas', '7'], ['Cierres', '3']], { now: NOW });
  assert.match(out, /• Llamadas agendadas: 7/);
  assert.match(out, /• Cierres: 3/);
});

test('formatMetrics: fila de 1 celda → sección en negrita; 3+ celdas → unidas con " · "', () => {
  const out = formatMetrics([['RESUMEN SEMANAL'], ['Lun', 'Mar', 'Mie']], { now: NOW });
  assert.match(out, /\*RESUMEN SEMANAL\*/);
  assert.match(out, /• Lun · Mar · Mie/);
});

test('formatMetrics: salta filas totalmente vacías', () => {
  const out = formatMetrics([['A', '1'], ['', ''], ['B', '2']], { now: NOW });
  const bullets = out.split('\n').filter((l) => l.startsWith('• '));
  assert.equal(bullets.length, 2); // la fila vacía no produce línea
});

test('formatMetrics: sin filas con contenido → lo dice', () => {
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
      const r = resolveRecipients();
      assert.deepEqual(r, ['144@lid', '158025419608301@lid']); // boss resuelto + LID, deduplicado
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
