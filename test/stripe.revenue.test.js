// test/stripe.revenue.test.js
// Cubre la VENTA NETA del reporte de EstadoX (§18.B, 2026-08-12): ventanas mes-a-la-fecha,
// la suma neta por moneda y el bloque formateado (incluida la variante SIN montos que iría
// al grupo). Todo puro + fetchImpl inyectado → corre en Windows sin better-sqlite3.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { monthToDateWindows, toNaiveMs } from '../src/sheets/window.js';
import { sumNet, buildRevenueMTD, isZeroDecimal } from '../src/stripe/revenue.js';
import { formatRevenueSection, formatReport } from '../src/sheets/report.js';
import { fetchChargesSince } from '../src/stripe/client.js';

// ─── monthToDateWindows ───────────────────────────────────────────────────────

test('monthToDateWindows: MTD de agosto vs. el MISMO tramo de julio', () => {
  // 12 de agosto de 2026, 21:30 Bogotá (= 02:30 UTC del 13).
  const { cur, prev } = monthToDateWindows(new Date(Date.UTC(2026, 7, 13, 2, 30)));
  assert.equal(cur.startMs, Date.UTC(2026, 7, 1));
  assert.equal(cur.endMs, Date.UTC(2026, 7, 12, 20));
  assert.equal(prev.startMs, Date.UTC(2026, 6, 1));
  assert.equal(prev.endMs, Date.UTC(2026, 6, 12, 20));
});

test('monthToDateWindows clampea el día: 31 de marzo compara contra el 28 de febrero', () => {
  const { prev } = monthToDateWindows(new Date(Date.UTC(2026, 2, 31, 15, 0)));
  assert.equal(prev.startMs, Date.UTC(2026, 1, 1));
  assert.equal(prev.endMs, Date.UTC(2026, 1, 28, 20)); // 2026 no es bisiesto
});

test('monthToDateWindows cruza el año: enero compara contra diciembre del año anterior', () => {
  const { cur, prev } = monthToDateWindows(new Date(Date.UTC(2026, 0, 5, 15, 0)));
  assert.equal(cur.startMs, Date.UTC(2026, 0, 1));
  assert.equal(prev.startMs, Date.UTC(2025, 11, 1));
  assert.equal(prev.endMs, Date.UTC(2025, 11, 5, 20));
});

// ─── sumNet ───────────────────────────────────────────────────────────────────

const WIN = { startMs: Date.UTC(2026, 7, 1), endMs: Date.UTC(2026, 7, 12, 20) };
const charge = (day, amount, extra = {}) => ({
  naiveMs: Date.UTC(2026, 7, day, 10),
  amount,
  amountRefunded: 0,
  currency: 'usd',
  status: 'succeeded',
  ...extra,
});

test('sumNet resta los reembolsos y solo cuenta los succeeded de la ventana', () => {
  const entries = [
    charge(3, 100000), // dentro
    charge(5, 50000, { amountRefunded: 20000 }), // reembolso parcial
    charge(7, 30000, { status: 'failed' }), // no succeeded → fuera
    charge(20, 999999), // fuera de la ventana (día 20 > corte del 12)
    { ...charge(9, 40000), naiveMs: null }, // sin timestamp usable → fuera
  ];
  const [usd] = sumNet(entries, WIN);
  assert.equal(usd.net, 100000 + (50000 - 20000));
  assert.equal(usd.charges, 2);
  assert.equal(usd.refunded, 20000);
});

test('sumNet: un cargo reembolsado por completo suma 0, no descuenta de los demás', () => {
  const entries = [charge(3, 100000), charge(4, 80000, { amountRefunded: 80000 })];
  const [usd] = sumNet(entries, WIN);
  assert.equal(usd.net, 100000);
  assert.equal(usd.charges, 2);
});

test('sumNet agrupa por moneda en vez de sumar peras con manzanas', () => {
  const entries = [charge(3, 100000), charge(4, 500000, { currency: 'cop' })];
  const totals = sumNet(entries, WIN);
  assert.equal(totals.length, 2);
  assert.deepEqual(
    totals.map((t) => [t.currency, t.net]).sort(),
    [['cop', 500000], ['usd', 100000]].sort()
  );
});

test('sumNet sin nada en la ventana devuelve lista vacía (no explota)', () => {
  assert.deepEqual(sumNet([], WIN), []);
  assert.deepEqual(sumNet(null, WIN), []);
});

test('isZeroDecimal distingue las monedas cuya unidad mínima ES la unidad', () => {
  assert.equal(isZeroDecimal('jpy'), true);
  assert.equal(isZeroDecimal('CLP'), true);
  assert.equal(isZeroDecimal('usd'), false);
  assert.equal(isZeroDecimal('cop'), false); // Stripe la maneja con dos decimales
});

// ─── formatRevenueSection ─────────────────────────────────────────────────────

const revenue = (curNet, prevNet, currency = 'usd') => ({
  cur: {
    win: { startMs: Date.UTC(2026, 7, 1), endMs: Date.UTC(2026, 7, 11, 20) },
    totals: curNet == null ? [] : [{ currency, net: curNet, charges: 1, refunded: 0 }],
  },
  prev: {
    win: { startMs: Date.UTC(2026, 6, 1), endMs: Date.UTC(2026, 6, 11, 20) },
    totals: prevNet == null ? [] : [{ currency, net: prevNet, charges: 1, refunded: 0 }],
  },
});

test('formatRevenueSection: dos líneas MTD con el % en la de arriba', () => {
  const txt = formatRevenueSection(revenue(1234000, 987000));
  assert.match(txt, /1–11 ago: US\$ 12\.340 \(\+25%\)/);
  assert.match(txt, /1–11 jul: US\$ 9\.870/);
  assert.match(txt, /Neto = cobros − reembolsos/);
  assert.match(txt, /reembolso baja el mes del cobro original/);
});

test('formatRevenueSection sin base (mes anterior en 0) NO muestra porcentaje', () => {
  const txt = formatRevenueSection(revenue(1234000, 0));
  assert.match(txt, /1–11 ago: US\$ 12\.340$/m);
  assert.doesNotMatch(txt, /%/);
});

test('formatRevenueSection sin ventas en ningún mes muestra 0, no se calla', () => {
  const txt = formatRevenueSection(revenue(null, null));
  assert.match(txt, /1–11 ago: US\$ 0/);
  assert.match(txt, /1–11 jul: US\$ 0/);
});

test('formatRevenueSection pinta cada moneda por separado', () => {
  const r = revenue(1234000, 987000);
  r.cur.totals.push({ currency: 'cop', net: 500000000, charges: 1, refunded: 0 });
  const txt = formatRevenueSection(r);
  assert.match(txt, /US\$ 12\.340/);
  assert.match(txt, /COP 5\.000\.000/);
});

// ─── el bloque de dinero NO sale al grupo ─────────────────────────────────────

const SUM = (extra) => ({ total: 0, breakdown: [], calendlyBooked: 0, ...extra });
const WIN_DIA = { startMs: Date.UTC(2026, 7, 11, 20), endMs: Date.UTC(2026, 7, 12, 20) };

test('formatReport con { revenue: false } no lleva montos (variante de grupo)', () => {
  const summary = SUM({ revenue: revenue(1234000, 987000) });
  const dm = formatReport(summary, WIN_DIA);
  const grupo = formatReport(summary, WIN_DIA, { revenue: false });
  assert.match(dm, /💵 Venta neta/);
  assert.match(dm, /US\$ 12\.340/);
  assert.doesNotMatch(grupo, /💵/);
  assert.doesNotMatch(grupo, /US\$/);
});

test('formatReport muestra UNA línea por cohorte configurada', () => {
  const summary = SUM({
    total: 3,
    cohorts: [
      { label: 'Cohorte 3 (Agosto)', count: 24 },
      { label: 'Cohorte 4 (Septiembre)', count: 6 },
    ],
  });
  const msg = formatReport(summary, WIN_DIA);
  assert.match(msg, /🎓 Cohorte 3 \(Agosto\): 24 confirmados/);
  assert.match(msg, /🎓 Cohorte 4 \(Septiembre\): 6 confirmados/);
});

test('formatReport sigue aceptando la forma vieja de UNA cohorte', () => {
  const msg = formatReport(SUM({ cohort: { label: 'Cohorte 3 (Agosto)', count: 24 } }), WIN_DIA);
  assert.match(msg, /🎓 Cohorte 3 \(Agosto\): 24 confirmados/);
});

// ─── fetchChargesSince ────────────────────────────────────────────────────────

const KEY_BACKUP = process.env.STRIPE_API_KEY;
beforeEach(() => {
  process.env.STRIPE_API_KEY = 'rk_test_dummy';
});
afterEach(() => {
  if (KEY_BACKUP === undefined) delete process.env.STRIPE_API_KEY;
  else process.env.STRIPE_API_KEY = KEY_BACKUP;
});

test('fetchChargesSince pagina y normaliza amount_refunded', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (calls.length === 1) {
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: 'ch_1', status: 'succeeded', created: 1000, amount: 50000, amount_refunded: 0, currency: 'usd' },
            { id: 'ch_2', status: 'succeeded', created: 1001, amount: 30000, amount_refunded: 30000, currency: 'usd' },
          ],
          has_more: true,
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        data: [{ id: 'ch_3', status: 'failed', created: 1002, amount: 10000, currency: 'usd' }],
        has_more: false,
      }),
    };
  };

  const out = await fetchChargesSince({ createdGteSec: 500, fetchImpl });
  assert.equal(out.length, 3); // el filtro de status lo hace sumNet, no el lector
  assert.deepEqual(out[1], {
    created: 1001,
    amount: 30000,
    amountRefunded: 30000,
    currency: 'usd',
    status: 'succeeded',
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /v1\/charges/);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer rk_test_dummy');
  assert.match(calls[1].url, /starting_after=ch_2/);
});

test('fetchChargesSince propaga el 403 de una rk_ sin permiso sobre Charges', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => 'no permission' });
  await assert.rejects(() => fetchChargesSince({ fetchImpl }), /charges 403/);
});

// El caller convierte el epoch REAL de Stripe a naive de Bogotá ANTES de comparar: un cobro
// de las 00:30 UTC del 1 de agosto es todavía el 31 de julio en Bogotá y NO debe contarse
// como venta de agosto.
test('buildRevenueMTD + toNaiveMs: un cobro de la madrugada UTC cae en el día de Bogotá', () => {
  const entry = (utcMs, amount) => {
    const created = Math.floor(utcMs / 1000);
    return {
      created,
      naiveMs: toNaiveMs(new Date(created * 1000)),
      amount,
      amountRefunded: 0,
      currency: 'usd',
      status: 'succeeded',
    };
  };
  const entries = [
    entry(Date.UTC(2026, 7, 1, 0, 30), 100000), // en Bogotá es el 31 de JULIO 19:30 → no es venta de agosto
    entry(Date.UTC(2026, 7, 2, 0, 30), 70000), // en Bogotá es el 1 de agosto 19:30 → sí
  ];
  const mtd = monthToDateWindows(new Date(Date.UTC(2026, 7, 13, 2, 30)));
  const r = buildRevenueMTD(entries, mtd);
  assert.equal(r.cur.totals[0].net, 70000);
  assert.equal(r.cur.totals[0].charges, 1);
  // Con el reloj UTC crudo, el primer cargo habría inflado agosto en US$ 1.000.
});
