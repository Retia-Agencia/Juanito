// test/sheets-weekly.test.js
// Cubre las comparativas semanales del reporte de EstadoX (§18.B): helpers de
// semana (lunes 00:00, ventanas parciales like-for-like), agregación semanal con
// pagos de Stripe o fallback al Sheet, y el formato del bloque para WhatsApp.
// No toca red ni DB → corre en Windows sin better-sqlite3.
//
// Calendario de los fixtures: el 1/6/2026 es LUNES → el 10/6/2026 es MIÉRCOLES.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toNaiveMs,
  startOfWeekMonday,
  lastFullWeekWindow,
  partialWeekWindows,
} from '../src/sheets/window.js';
import { windowTotals, buildWeeklySections } from '../src/sheets/weekly.js';
import { formatWeeklySections, formatReport } from '../src/sheets/report.js';
import { summarize } from '../src/sheets/aggregate.js';
import { COL, SETTEO } from '../src/sheets/columns.js';

const DAY_MS = 24 * 3600 * 1000;

// Miércoles 10-jun-2026 8:00pm Bogotá (hora del reporte).
const WED = new Date('2026-06-10T20:00:00-05:00');

// ─── startOfWeekMonday / toNaiveMs ────────────────────────────────────────────

test('startOfWeekMonday: miércoles → lunes de esa semana (00:00 Bogotá, naive)', () => {
  assert.equal(startOfWeekMonday(WED), Date.UTC(2026, 5, 8));
});

test('startOfWeekMonday: un lunes es su propio inicio de semana, a cualquier hora', () => {
  assert.equal(startOfWeekMonday(new Date('2026-06-08T00:00:01-05:00')), Date.UTC(2026, 5, 8));
  assert.equal(startOfWeekMonday(new Date('2026-06-08T23:59:00-05:00')), Date.UTC(2026, 5, 8));
});

test('startOfWeekMonday: domingo → el lunes 6 días atrás (getUTCDay domingo=0)', () => {
  assert.equal(startOfWeekMonday(new Date('2026-06-14T10:00:00-05:00')), Date.UTC(2026, 5, 8));
});

test('toNaiveMs convierte epoch real → epoch de pared de Bogotá', () => {
  // 11-jun 00:30 UTC = 10-jun 19:30 Bogotá.
  assert.equal(toNaiveMs(new Date('2026-06-11T00:30:00Z')), Date.UTC(2026, 5, 10, 19, 30, 0));
});

// ─── lastFullWeekWindow / partialWeekWindows ──────────────────────────────────

test('lastFullWeekWindow: lunes-a-lunes de la semana pasada, cualquier día de la semana', () => {
  const expected = { startMs: Date.UTC(2026, 5, 1), endMs: Date.UTC(2026, 5, 8) };
  assert.deepEqual(lastFullWeekWindow(WED), expected); // miércoles
  assert.deepEqual(lastFullWeekWindow(new Date('2026-06-08T09:00:00-05:00')), expected); // lunes
  assert.deepEqual(lastFullWeekWindow(new Date('2026-06-14T22:00:00-05:00')), expected); // domingo
});

test('partialWeekWindows: 4 ventanas [lun 00:00, hoy 20:00) desplazadas 7d exactos', () => {
  const wins = partialWeekWindows(WED);
  assert.equal(wins.length, 4);
  // k=0 = semana en curso: lun 8/6 00:00 → mié 10/6 20:00.
  assert.deepEqual(wins[0], { startMs: Date.UTC(2026, 5, 8), endMs: Date.UTC(2026, 5, 10, 20) });
  for (let k = 1; k < 4; k++) {
    assert.equal(wins[k].startMs, wins[0].startMs - k * 7 * DAY_MS);
    assert.equal(wins[k].endMs, wins[0].endMs - k * 7 * DAY_MS);
  }
});

test('partialWeekWindows en lunes: ventanas de 20h, comparables entre sí', () => {
  const wins = partialWeekWindows(new Date('2026-06-08T20:00:00-05:00'));
  assert.deepEqual(wins[0], { startMs: Date.UTC(2026, 5, 8), endMs: Date.UTC(2026, 5, 8, 20) });
  assert.equal(wins[0].endMs - wins[0].startMs, 20 * 3600 * 1000);
  assert.equal(wins[3].endMs - wins[3].startMs, 20 * 3600 * 1000);
});

// ─── windowTotals / buildWeeklySections ───────────────────────────────────────

// Filas sintéticas (mismos helpers que test/sheets.test.js). Las marcas del tab de
// leads vienen en GMT-2 → parseSubmittedAt les resta 3h para llevarlas a Bogotá.
function row({ submittedAt, calendly = '' }) {
  const r = [];
  r[COL.submittedAt] = submittedAt;
  r[COL.calendly] = calendly;
  return r;
}

function setteoRow({ fecha, estadoPago = '' }) {
  const r = [];
  r[SETTEO.fecha] = fecha;
  r[SETTEO.estadoPago] = estadoPago;
  return r;
}

// Horas escritas en GMT-2: "13:00:00" = 10:00am Bogotá.
const ROWS = [
  ['Submitted At'], // encabezado → fuera
  row({ submittedAt: '17/5/2026 13:00:00' }), // dom 17-may → fuera de toda ventana; ancla historyOk
  row({ submittedAt: '19/5/2026 13:00:00' }), // mar 19-may → parcial k=3
  row({ submittedAt: '26/5/2026 13:00:00' }), // mar 26-may → semana ANTERIOR a la pasada + parcial k=2
  row({ submittedAt: '2/6/2026 13:00:00', calendly: 'https://calendly.com/x/invitees/a' }), // mar 2-jun → semana pasada + parcial k=1
  row({ submittedAt: '5/6/2026 13:00:00' }), // vie 5-jun → semana pasada, NO parcial k=1 (después del mié 20:00)
  row({ submittedAt: '9/6/2026 13:00:00' }), // mar 9-jun → semana en curso (k=0)
];

// Fechas del tab de setteo SIN desfase (SETTEO_AHEAD_HOURS default 0).
const SETTEO_ROWS = [
  ['Fecha detección'],
  setteoRow({ fecha: '2/06/2026 10:00', estadoPago: '💳 Self-checkout' }), // semana pasada + k=1
  setteoRow({ fecha: '9/06/2026 10:00', estadoPago: 'No hizo self-checkout' }), // k=0: reached sin pagar
];

// Pagos Stripe ya convertidos a naive (hora de pared Bogotá).
const PAYMENTS = [
  Date.UTC(2026, 5, 9, 12), // mar 9-jun → k=0
  Date.UTC(2026, 5, 2, 12), // mar 2-jun → semana pasada + k=1
  Date.UTC(2026, 4, 26, 12), // mar 26-may → semana anterior + k=2
];

test('windowTotals junta funnel + pagos Stripe de una ventana', () => {
  const win = { startMs: Date.UTC(2026, 5, 1), endMs: Date.UTC(2026, 5, 8) };
  const t = windowTotals(ROWS, SETTEO_ROWS, win, PAYMENTS);
  assert.deepEqual(t, { total: 2, calendly: 1, reached: 1, paid: 1, payments: 1 });
});

test('windowTotals sin datos de Stripe deja payments=null (fallback al tag del Sheet)', () => {
  const win = { startMs: Date.UTC(2026, 5, 1), endMs: Date.UTC(2026, 5, 8) };
  assert.equal(windowTotals(ROWS, SETTEO_ROWS, win, null).payments, null);
});

test('buildWeeklySections reparte las métricas por semana (completa y parciales)', () => {
  const w = buildWeeklySections(ROWS, SETTEO_ROWS, WED, PAYMENTS);

  // Semana pasada (1/6 → 8/6): 2 leads, 1 calendly, 1 pago; anterior (25/5): 1 lead, 1 pago.
  assert.equal(w.lastWeek.metrics.total, 2);
  assert.equal(w.lastWeek.metrics.calendly, 1);
  assert.equal(w.lastWeek.metrics.payments, 1);
  assert.equal(w.lastWeek.prev.metrics.total, 1);
  assert.equal(w.lastWeek.prev.metrics.payments, 1);

  // Parciales (lun → mié 20:00), índice 0 = en curso: 1 lead por semana; el viernes
  // 5-jun de la semana pasada NO entra en la parcial k=1.
  assert.deepEqual(w.partialWeeks.map((p) => p.metrics.total), [1, 1, 1, 1]);
  assert.deepEqual(w.partialWeeks.map((p) => p.metrics.payments), [1, 1, 1, 0]);
  assert.equal(w.partialWeeks[0].metrics.reached, 1); // "No hizo self-checkout" llegó sin pagar
  assert.equal(w.partialWeeks[0].metrics.paid, 0);

  assert.equal(w.paymentsSource, 'stripe');
  assert.equal(w.historyOk, true); // hay una fila del 17-may, anterior al lun 18-may (k=3)
});

test('buildWeeklySections sin Stripe: paymentsSource=sheet y pagos=null', () => {
  const w = buildWeeklySections(ROWS, SETTEO_ROWS, WED, null);
  assert.equal(w.paymentsSource, 'sheet');
  assert.equal(w.lastWeek.metrics.payments, null);
});

test('buildWeeklySections marca historyOk=false si el Sheet no cubre la ventana más vieja', () => {
  const recentOnly = [row({ submittedAt: '9/6/2026 13:00:00' })];
  const w = buildWeeklySections(recentOnly, [], WED, null);
  assert.equal(w.historyOk, false);
});

// ─── formatWeeklySections / formatReport extendido ────────────────────────────

test('formatWeeklySections: promedio diario con deltas firmados y 4 semanas viejo→nuevo', () => {
  const w = buildWeeklySections(ROWS, SETTEO_ROWS, WED, PAYMENTS);
  const msg = formatWeeklySections(w);

  // Semana pasada lun 1/6 → dom 7/6, en promedio POR DÍA (÷7) con delta vs la anterior.
  assert.match(msg, /📅 Semana pasada \(lun 1\/6 → dom 7\/6\)/);
  assert.match(msg, /• Leads: 0\.3\/día \(ant: 0\.1, \+0\.2\)/); // 2/7 vs 1/7
  assert.match(msg, /• Calendly: 0\.1\/día \(ant: 0\.0, \+0\.1\)/);
  assert.match(msg, /• Pagos: 0\.1\/día \(ant: 0\.1, \+0\.0\)/);

  // 4 semanas like-for-like en tasa diaria (÷2.83 días: lun 00:00 → mié 20:00),
  // rótulo con el día actual y corte 8pm, viejo→nuevo.
  assert.match(msg, /📈 Últimas 4 semanas — lun → mié 8:00pm/);
  const bullets = msg.split('\n').filter((l) => / leads\/d · /.test(l));
  assert.equal(bullets.length, 4);
  assert.match(bullets[0], /^• 18\/5: 0\.4 leads\/d · 0\.0 cal\/d · 0\.0 chk\/d · 0\.0 pagos\/d$/);
  assert.match(bullets[3], /^• 8\/6 \(en curso\): 0\.4 leads\/d · 0\.0 cal\/d · 0\.4 chk\/d · 0\.4 pagos\/d$/);

  assert.match(msg, /Pagos: Stripe \(solo conteo\)/);
  assert.doesNotMatch(msg, /histórico/); // historyOk=true → sin advertencia
  assert.doesNotMatch(msg, /\$\d/); // jamás montos de dinero
});

test('formatWeeklySections: delta negativo con signo y fallback al tag del Sheet', () => {
  // Semana pasada peor que la anterior, sin Stripe.
  const win = (s, e) => ({ startMs: s, endMs: e });
  const metrics = (total, paid) => ({ total, calendly: 0, reached: 0, paid, payments: null });
  const w = {
    lastWeek: {
      win: win(Date.UTC(2026, 5, 1), Date.UTC(2026, 5, 8)),
      metrics: metrics(3, 1),
      prev: { win: win(Date.UTC(2026, 4, 25), Date.UTC(2026, 5, 1)), metrics: metrics(7, 4) },
    },
    partialWeeks: partialWeekWindows(WED).map((pw) => ({ win: pw, metrics: metrics(0, 0) })),
    historyOk: false,
    paymentsSource: 'sheet',
  };
  const msg = formatWeeklySections(w);
  assert.match(msg, /• Leads: 0\.4\/día \(ant: 1\.0, -0\.6\)/); // 3/7 vs 7/7
  assert.match(msg, /• Pagos: 0\.1\/día \(ant: 0\.6, -0\.5\)/); // sin Stripe usa el paid del Sheet
  assert.match(msg, /Pagos: tag del Sheet/);
  assert.match(msg, /⚠️ El histórico del Sheet no cubre todas las semanas/);
});

test('formatReport anexa la línea de Stripe del día y el bloque semanal', () => {
  const win = { startMs: Date.UTC(2026, 5, 9, 20), endMs: Date.UTC(2026, 5, 10, 20) };
  const summary = {
    ...summarize([row({ submittedAt: '10/6/2026 9:00:00' })], win),
    selfCheckout: { reached: 2, paid: 1 },
    stripeToday: 3,
    weekly: buildWeeklySections(ROWS, SETTEO_ROWS, WED, PAYMENTS),
  };
  const msg = formatReport(summary, win);
  assert.match(msg, /💰 Pagos confirmados \(Stripe\): 3/);
  assert.match(msg, /📅 Semana pasada/);
  assert.match(msg, /📈 Últimas 4 semanas/);
  // La línea de self-checkout del Sheet se mantiene como métrica de funnel.
  assert.match(msg, /Llegaron al self-checkout: 2 \(pagaron: 1\)/);
});

test('formatReport con día vacío igual muestra pagos y comparativas semanales', () => {
  const win = { startMs: Date.UTC(2026, 5, 9, 20), endMs: Date.UTC(2026, 5, 10, 20) };
  const summary = {
    ...summarize([], win),
    stripeToday: 1,
    weekly: buildWeeklySections(ROWS, SETTEO_ROWS, WED, PAYMENTS),
  };
  const msg = formatReport(summary, win);
  assert.match(msg, /No llegaron postulaciones/);
  assert.match(msg, /💰 Pagos confirmados \(Stripe\): 1/);
  assert.match(msg, /📅 Semana pasada/);
});

test('formatReport sin weekly ni stripeToday queda idéntico al formato clásico', () => {
  const win = { startMs: Date.UTC(2026, 5, 9, 20), endMs: Date.UTC(2026, 5, 10, 20) };
  const msg = formatReport(summarize([], win), win);
  assert.match(msg, /No llegaron postulaciones/);
  assert.doesNotMatch(msg, /Stripe|Semana pasada|Últimas/);
});
