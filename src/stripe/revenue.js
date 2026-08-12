// src/stripe/revenue.js
// PURO. Suma la VENTA NETA de una ventana a partir de los cargos que trae
// `fetchChargesSince` (client.js). "Neta" = cobros − reembolsos, ANTES de la comisión de
// Stripe: es el mismo criterio que el "net volume from sales" del dashboard, para que el
// número del reporte cuadre con lo que se ve en Stripe.
//
// Entra `entries` con el timestamp YA convertido a epoch "naive" de Bogotá (`naiveMs`),
// porque el resto del módulo de reporte compara en naive y mezclar relojes corrompe la
// ventana en silencio. La conversión (toNaiveMs) la hace el caller impuro.
//
// Los montos vienen en la unidad MÍNIMA de la moneda (centavos), tal cual los da Stripe.
// El formateo a unidades es cosa de report.js.

// Monedas sin decimales en Stripe: su "unidad mínima" ES la unidad. Dividir por 100 acá
// mostraría 1/100 de la venta. (Ojo: COP NO está en esta lista — Stripe la maneja con
// dos decimales aunque en la calle se cobre en pesos enteros.)
const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

export const isZeroDecimal = (currency) => ZERO_DECIMAL.has(String(currency || '').toLowerCase());

// Venta neta de `win`, agrupada por moneda de LIQUIDACIÓN. La cuenta cobra en varias
// monedas (usd y cop) pero liquida en USD, así que cada cargo se cuenta con el monto YA
// convertido por Stripe (`settledAmount`) y todo cae en un solo total. La agrupación se
// conserva igual: si algún día la cuenta liquidara en dos monedas, sumarlas sería mentir.
//
// Devuelve [{ currency, net, charges, refunded, converted }], de mayor a menor.
// `converted` marca que ahí adentro hay cobros que estaban en otra moneda — el mensaje lo
// dice al pie, porque un total en dólares que incluye pesos convertidos no es evidente.
//
// Sin `settledAmount` (expansión no disponible, bt pendiente) cae a la moneda original del
// cargo: mejor un total partido en dos monedas que uno unificado con un número inventado.
//
// El reembolso viene en la moneda del CARGO, así que se convierte con la misma tasa del
// cargo. Es una aproximación —Stripe le asigna al reembolso su propia balance transaction,
// con su propia tasa— pero mantiene la atribución por fecha de cobro y es exacta al centavo
// para los cargos que ya estaban en la moneda de liquidación (la enorme mayoría).
// Un cargo reembolsado por completo suma 0 (no se descuenta de otro).
export function sumNet(entries, { startMs, endMs }) {
  const byCurrency = new Map();
  for (const e of entries || []) {
    if (e?.status !== 'succeeded') continue;
    const ms = e.naiveMs;
    if (ms == null || ms < startMs || ms >= endMs) continue;

    const original = String(e.currency || 'usd').toLowerCase();
    const hasSettled = e.settledAmount != null && e.settledCurrency;
    const currency = hasSettled ? String(e.settledCurrency).toLowerCase() : original;
    const rate = hasSettled ? (e.exchangeRate ?? 1) : 1;
    const gross = hasSettled ? e.settledAmount : e.amount || 0;
    const refunded = Math.round((e.amountRefunded || 0) * rate);

    const acc = byCurrency.get(currency) || {
      currency,
      net: 0,
      charges: 0,
      refunded: 0,
      converted: false,
    };
    acc.net += gross - refunded;
    acc.refunded += refunded;
    acc.charges += 1;
    if (currency !== original) acc.converted = true;
    byCurrency.set(currency, acc);
  }
  return [...byCurrency.values()].sort((a, b) => b.net - a.net || a.currency.localeCompare(b.currency));
}

// Las dos ventanas del bloque MTD, listas para formatear. `windows` sale de
// monthToDateWindows (src/sheets/window.js).
export function buildRevenueMTD(entries, { cur, prev }) {
  return {
    cur: { win: cur, totals: sumNet(entries, cur) },
    prev: { win: prev, totals: sumNet(entries, prev) },
  };
}
