// test/stripe.test.js
// Cubre el código PURO del módulo de pagos reales (Stripe) que alimenta el `pagaron:`
// del reporte diario de EstadoX: conversión de ventana naive→UTC, conteo de
// PaymentIntents `succeeded` y el "hoy + promedio de 7 días previos". No toca red ni
// DB → corre en Windows sin better-sqlite3.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tzOffsetMs, windowToUnixSeconds, countPaid, paidTodayAndAvg } from '../src/stripe/count.js';
import { formatReport } from '../src/sheets/report.js';

// Ventana naive (hora de pared de Bogotá) idéntica a la que usa el reporte:
// [9/6 8:00pm, 10/6 8:00pm) Bogotá.
const WIN = {
  startMs: Date.UTC(2026, 5, 9, 20, 0, 0),
  endMs: Date.UTC(2026, 5, 10, 20, 0, 0),
};
// Su equivalente en instantes UTC REALES (Bogotá = UTC−5): 8:00pm Bogotá = 01:00 UTC
// del día siguiente.
const REAL_START = Date.UTC(2026, 5, 10, 1, 0, 0) / 1000; // seg
const REAL_END = Date.UTC(2026, 5, 11, 1, 0, 0) / 1000;

const NOW = new Date('2026-06-10T20:00:00-05:00'); // 10-jun 8:00pm Bogotá

// PaymentIntent mínimo: created en SEGUNDOS UTC.
function pi(createdSec, status = 'succeeded', amount = 100000) {
  return { id: `pi_${createdSec}_${status}`, created: createdSec, status, amount_received: amount };
}

// ─── tzOffsetMs / windowToUnixSeconds ─────────────────────────────────────────

test('tzOffsetMs: Bogotá es UTC−5 fijo (sin horario de verano)', () => {
  assert.equal(tzOffsetMs(NOW, 'America/Bogota'), -5 * 3600 * 1000);
});

test('windowToUnixSeconds traduce la ventana naive de Bogotá a segundos UTC reales', () => {
  const { startSec, endSec } = windowToUnixSeconds(WIN, NOW);
  assert.equal(startSec, REAL_START);
  assert.equal(endSec, REAL_END);
});

// ─── countPaid ────────────────────────────────────────────────────────────────

test('countPaid cuenta solo `succeeded` dentro de [startSec, endSec) y suma montos', () => {
  const intents = [
    pi(REAL_START), // inicio inclusivo → cuenta
    pi(REAL_END - 1), // justo antes del fin → cuenta
    pi(REAL_END), // fin exclusivo → fuera
    pi(REAL_START - 1), // antes del inicio → fuera
    pi(REAL_START + 100, 'requires_payment_method'), // dentro pero no pagó → fuera
    pi(REAL_START + 200, 'canceled'), // dentro pero cancelado → fuera
  ];
  const { paid, amountCents } = countPaid(intents, { startSec: REAL_START, endSec: REAL_END });
  assert.equal(paid, 2);
  assert.equal(amountCents, 200000); // 2 × 100000
});

test('countPaid tolera lista vacía/nula', () => {
  assert.deepEqual(countPaid([], { startSec: 0, endSec: 1 }), { paid: 0, amountCents: 0 });
  assert.deepEqual(countPaid(null, { startSec: 0, endSec: 1 }), { paid: 0, amountCents: 0 });
});

// ─── paidTodayAndAvg ──────────────────────────────────────────────────────────

test('paidTodayAndAvg: cuenta hoy y promedia los 7 previos EXCLUYENDO hoy', () => {
  const intents = [
    // HOY (10/6 01:00Z → 11/6 01:00Z): 2 pagos + 1 no-pagado (no cuenta).
    pi(Date.UTC(2026, 5, 10, 15, 0, 0) / 1000),
    pi(Date.UTC(2026, 5, 10, 18, 0, 0) / 1000),
    pi(Date.UTC(2026, 5, 10, 16, 0, 0) / 1000, 'canceled'),
    // Día −1 (9/6 01:00Z → 10/6 01:00Z): 1 pago.
    pi(Date.UTC(2026, 5, 9, 15, 0, 0) / 1000),
    // Día −2 (8/6 01:00Z → 9/6 01:00Z): 3 pagos.
    pi(Date.UTC(2026, 5, 8, 10, 0, 0) / 1000),
    pi(Date.UTC(2026, 5, 8, 12, 0, 0) / 1000),
    pi(Date.UTC(2026, 5, 8, 14, 0, 0) / 1000),
  ];
  const { today, avgPrior, days } = paidTodayAndAvg(intents, NOW, { days: 7 });
  assert.equal(today, 2); // el cancelado no cuenta
  assert.equal(days, 7);
  // Previos = 1 (día −1) + 3 (día −2) = 4 sobre 7 → 0.6 (si colara hoy sería 0.9).
  assert.equal(avgPrior.toFixed(1), '0.6');
});

// ─── marcador ✅ Stripe en el reporte ─────────────────────────────────────────

test('formatReport marca "✅ Stripe" cuando paidSource=stripe, y no cuando falta', () => {
  const base = {
    total: 5,
    calendlyBooked: 2,
    breakdown: [],
    selfCheckout: { reached: 4, paid: 3 },
  };
  // Con Stripe: el número de pagos lleva el sello.
  const withStripe = formatReport({ ...base, paidSource: 'stripe' }, WIN);
  assert.match(withStripe, /Llegaron al self-checkout: 4 \(pagaron: 3 ✅ Stripe\)/);
  // Sin Stripe (cuenta del Sheet): sin sello (comportamiento previo intacto).
  const noStripe = formatReport(base, WIN);
  assert.match(noStripe, /Llegaron al self-checkout: 4 \(pagaron: 3\)/);
  assert.doesNotMatch(noStripe, /Stripe/);
});
