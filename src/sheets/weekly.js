// src/sheets/weekly.js
// PURO. Datos de la tendencia semanal del reporte de EstadoX (§18.B). Devuelve N
// semanas like-for-like: lunes → mismo día/corte de hoy, desplazado k·7d, para
// comparar manzanas con manzanas aunque la semana vaya a medias (el formatter las
// pinta en un bloque único con etiquetas relativas; redesign 2026-07-17). También
// arma `lastWeek` (semana completa lun-dom + la previa) — hoy solo lo usa `historyOk`,
// no se renderiza.
//
// Mismo patrón que averagePriorDays (aggregate.js): re-agrega sobre las filas ya
// leídas, sin costo de red. Los pagos salen de Stripe (timestamps naive) cuando hay
// datos; si no, del tag manual del Sheet (col "Estado pago"), como siempre.

import { summarize, countSelfCheckout } from './aggregate.js';
import { COL } from './columns.js';
import { parseSubmittedAt } from './parse.js';
import { lastFullWeekWindow, partialWeekWindows } from './window.js';

const WEEK_MS = 7 * 24 * 3600 * 1000;

// Totales de funnel de una ventana. `payments` = pagos Stripe dentro de la ventana,
// o null si no hay datos de Stripe (el formateador cae al `paid` del Sheet).
//
// Split de pagos (§18.AD/redesign 2026-07-17):
//   - `auto` = pagos por CHECKOUT AUTOMÁTICO (self-checkout). Atribuidos por Payment Link
//     en Stripe (`selfCheckoutNaiveMs`) si hay datos — misma fuente que `payments`; si no,
//     caen al tag manual del Sheet (`sc.paid`).
//   - `call` = pagos CERRADOS EN LLAMADA = total Stripe − auto. Es una RESTA, así que solo
//     existe si hay total de Stripe; sin Stripe queda `null` (n/d). Nunca negativo:
//     `fetchSucceededPaymentTimestampsForLink` garantiza que auto ⊆ payments, y el
//     Math.max(0, …) cubre el caso degradado del tag del Sheet.
export function windowTotals(rows, setteoRows, win, paymentsNaiveMs = null, selfCheckoutNaiveMs = null) {
  const s = summarize(rows, win);
  const sc = countSelfCheckout(setteoRows, win);
  const inWin = (arr) => arr.filter((ms) => ms >= win.startMs && ms < win.endMs).length;
  const payments = paymentsNaiveMs ? inWin(paymentsNaiveMs) : null;
  const auto = selfCheckoutNaiveMs ? inWin(selfCheckoutNaiveMs) : sc.paid;
  const call = payments != null ? Math.max(0, payments - auto) : null;
  return { total: s.total, calendly: s.calendlyBooked, reached: sc.reached, paid: sc.paid, payments, auto, call };
}

// Arma las dos secciones comparativas. `paymentsNaiveMs` = timestamps naive de los
// PaymentIntents `succeeded` (null → sin Stripe, se usa el tag del Sheet).
// `historyOk` avisa si la fila parseable más vieja del Sheet no alcanza a cubrir la
// ventana más antigua (los conteos viejos saldrían incompletos).
export function buildWeeklySections(
  rows,
  setteoRows,
  now,
  paymentsNaiveMs = null,
  { weeks = 4, selfCheckoutNaiveMs = null } = {}
) {
  const lastWin = lastFullWeekWindow(now);
  const prevWin = { startMs: lastWin.startMs - WEEK_MS, endMs: lastWin.endMs - WEEK_MS };
  const partials = partialWeekWindows(now, { weeks });
  const totals = (win) => windowTotals(rows, setteoRows, win, paymentsNaiveMs, selfCheckoutNaiveMs);

  const lastWeek = {
    win: lastWin,
    metrics: totals(lastWin),
    prev: { win: prevWin, metrics: totals(prevWin) },
  };
  const partialWeeks = partials.map((win) => ({ win, metrics: totals(win) }));

  const oldestNeeded = Math.min(prevWin.startMs, partials[partials.length - 1].startMs);
  let oldestRow = null;
  for (const r of rows || []) {
    const ts = parseSubmittedAt(r?.[COL.submittedAt]);
    if (ts != null && (oldestRow == null || ts < oldestRow)) oldestRow = ts;
  }
  const historyOk = oldestRow != null && oldestRow <= oldestNeeded;

  return {
    lastWeek,
    partialWeeks,
    historyOk,
    paymentsSource: paymentsNaiveMs ? 'stripe' : 'sheet',
  };
}
