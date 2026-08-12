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

// Venta neta de `win`, agrupada POR MONEDA. Sumar monedas distintas sería mentir, así que
// devuelve una entrada por moneda: [{ currency, net, charges, refunded }], de mayor a
// menor. Un cargo reembolsado por completo suma 0 (no se descuenta de otro).
export function sumNet(entries, { startMs, endMs }) {
  const byCurrency = new Map();
  for (const e of entries || []) {
    if (e?.status !== 'succeeded') continue;
    const ms = e.naiveMs;
    if (ms == null || ms < startMs || ms >= endMs) continue;
    const currency = String(e.currency || 'usd').toLowerCase();
    const acc = byCurrency.get(currency) || { currency, net: 0, charges: 0, refunded: 0 };
    acc.net += (e.amount || 0) - (e.amountRefunded || 0);
    acc.refunded += e.amountRefunded || 0;
    acc.charges += 1;
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
