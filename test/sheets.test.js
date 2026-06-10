// test/sheets.test.js
// Cubre el código PURO del reporte diario de Sheets (§18.B): parseo de la marca
// temporal, ventana de Bogotá, agregación con porcentajes y formato del mensaje.
// No toca red ni DB → corre en Windows sin better-sqlite3.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSubmittedAt } from '../src/sheets/parse.js';
import { computeWindow, zonedParts } from '../src/sheets/window.js';
import { summarize } from '../src/sheets/aggregate.js';
import { formatReport } from '../src/sheets/report.js';
import { COL } from '../src/sheets/columns.js';

// ─── parseSubmittedAt ─────────────────────────────────────────────────────────

test('parseSubmittedAt entiende D/M/YYYY H:MM:SS (día primero)', () => {
  // 9 de junio, no 6 de septiembre.
  const ms = parseSubmittedAt('9/6/2026 17:03:04');
  assert.equal(ms, Date.UTC(2026, 5, 9, 17, 3, 4));
});

test('parseSubmittedAt tolera medianoche y segundos opcionales', () => {
  assert.equal(parseSubmittedAt('10/6/2026 0:34:09'), Date.UTC(2026, 5, 10, 0, 34, 9));
  assert.equal(parseSubmittedAt('1/1/2026 8:05'), Date.UTC(2026, 0, 1, 8, 5, 0));
});

test('parseSubmittedAt devuelve null para encabezado o basura', () => {
  assert.equal(parseSubmittedAt('Submitted At'), null);
  assert.equal(parseSubmittedAt(''), null);
  assert.equal(parseSubmittedAt(null), null);
  assert.equal(parseSubmittedAt('2026-06-09T17:03:04Z'), null); // ISO no es el formato del Form
  assert.equal(parseSubmittedAt('32/1/2026 0:00:00'), null); // día inválido
});

// ─── computeWindow ────────────────────────────────────────────────────────────

test('computeWindow → [ayer 20:00, hoy 20:00) en hora de pared de Bogotá', () => {
  const now = new Date('2026-06-10T20:00:00-05:00'); // 10-jun 8:00pm Bogotá
  const { startMs, endMs } = computeWindow(now);
  assert.equal(endMs, Date.UTC(2026, 5, 10, 20, 0, 0));
  assert.equal(startMs, Date.UTC(2026, 5, 9, 20, 0, 0));
});

test('zonedParts ve la fecha local de Bogotá, no UTC', () => {
  // 11-jun 00:30 UTC es aún 10-jun 19:30 en Bogotá (UTC-5).
  const p = zonedParts(new Date('2026-06-11T00:30:00Z'));
  assert.equal(p.y, 2026);
  assert.equal(p.m, 6);
  assert.equal(p.d, 10);
  assert.equal(p.H, 19);
});

// ─── summarize ────────────────────────────────────────────────────────────────

// Construye una fila del Sheet con sólo las columnas que importan.
function row({ submittedAt, momento = '', iaPrev = '', inversion = '' }) {
  const r = [];
  r[COL.submittedAt] = submittedAt;
  r[COL.momento] = momento;
  r[COL.iaPrev] = iaPrev;
  r[COL.inversion] = inversion;
  return r;
}

const WIN = {
  startMs: Date.UTC(2026, 5, 9, 20, 0, 0),
  endMs: Date.UTC(2026, 5, 10, 20, 0, 0),
};

test('summarize cuenta sólo las filas dentro de la ventana (bordes incluidos)', () => {
  const rows = [
    ['Submitted At'], // encabezado → fuera
    row({ submittedAt: '9/6/2026 19:59:59' }), // justo antes del inicio → fuera
    row({ submittedAt: '9/6/2026 20:00:00' }), // inicio inclusivo → dentro
    row({ submittedAt: '10/6/2026 0:34:09' }), // dentro
    row({ submittedAt: '10/6/2026 20:00:00' }), // fin exclusivo → fuera
  ];
  const s = summarize(rows, WIN);
  assert.equal(s.total, 2);
});

test('summarize agrupa por categoría y saca % sobre los NO vacíos', () => {
  const rows = [
    row({ submittedAt: '10/6/2026 9:00:00', momento: 'Abogado Jr.', iaPrev: 'TRUE', inversion: 'Sí' }),
    row({ submittedAt: '10/6/2026 10:00:00', momento: 'Abogado Jr.', iaPrev: 'FALSE', inversion: 'No' }),
    row({ submittedAt: '10/6/2026 11:00:00', momento: 'Litigante', iaPrev: '', inversion: 'Sí' }),
  ];
  const s = summarize(rows, WIN);
  assert.equal(s.total, 3);

  const momento = s.breakdown.find((b) => b.key === 'momento');
  assert.equal(momento.answered, 3);
  assert.deepEqual(
    momento.items.map((i) => [i.value, i.count, i.pct]),
    [['Abogado Jr.', 2, 67], ['Litigante', 1, 33]]
  );

  // iaPrev: sólo 2 respondieron (uno vacío) → % sobre 2, y TRUE/FALSE → Sí/No.
  const ia = s.breakdown.find((b) => b.key === 'iaPrev');
  assert.equal(ia.answered, 2);
  assert.deepEqual(
    ia.items.map((i) => [i.value, i.count, i.pct]).sort(),
    [['No', 1, 50], ['Sí', 1, 50]]
  );
});

// ─── formatReport ─────────────────────────────────────────────────────────────

test('formatReport arma el mensaje con total, periodo y desglose (sin PII)', () => {
  const rows = [
    row({ submittedAt: '10/6/2026 9:00:00', momento: 'Litigante', iaPrev: 'TRUE', inversion: 'Sí' }),
  ];
  const msg = formatReport(summarize(rows, WIN), WIN);
  assert.match(msg, /Reporte de leads/);
  assert.match(msg, /9\/6 8:00pm → 10\/6 8:00pm/);
  assert.match(msg, /Total de entradas: 1/);
  assert.match(msg, /Momento profesional/);
  assert.match(msg, /Litigante: 1 \(100%\)/);
  // Sin PII: no debe haber correos ni teléfonos.
  assert.doesNotMatch(msg, /@|\+?\d{7,}/);
});

test('formatReport con ventana vacía dice que no llegaron postulaciones', () => {
  const msg = formatReport(summarize([], WIN), WIN);
  assert.match(msg, /Total de entradas: 0/);
  assert.match(msg, /No llegaron postulaciones/);
});
