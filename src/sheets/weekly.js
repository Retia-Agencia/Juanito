// src/sheets/weekly.js
// PURO. Comparativas semanales del reporte de EstadoX (§18.B):
//   - Semana pasada completa (lun 00:00 → lun 00:00) con delta vs la anterior.
//   - Últimas 4 semanas like-for-like: lunes → mismo día/corte de hoy, desplazado
//     k·7d, para comparar manzanas con manzanas aunque la semana vaya a medias.
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
export function windowTotals(rows, setteoRows, win, paymentsNaiveMs = null) {
  const s = summarize(rows, win);
  const sc = countSelfCheckout(setteoRows, win);
  const payments = paymentsNaiveMs
    ? paymentsNaiveMs.filter((ms) => ms >= win.startMs && ms < win.endMs).length
    : null;
  return { total: s.total, calendly: s.calendlyBooked, reached: sc.reached, paid: sc.paid, payments };
}

// Arma las dos secciones comparativas. `paymentsNaiveMs` = timestamps naive de los
// PaymentIntents `succeeded` (null → sin Stripe, se usa el tag del Sheet).
// `historyOk` avisa si la fila parseable más vieja del Sheet no alcanza a cubrir la
// ventana más antigua (los conteos viejos saldrían incompletos).
export function buildWeeklySections(rows, setteoRows, now, paymentsNaiveMs = null, { weeks = 4 } = {}) {
  const lastWin = lastFullWeekWindow(now);
  const prevWin = { startMs: lastWin.startMs - WEEK_MS, endMs: lastWin.endMs - WEEK_MS };
  const partials = partialWeekWindows(now, { weeks });

  const lastWeek = {
    win: lastWin,
    metrics: windowTotals(rows, setteoRows, lastWin, paymentsNaiveMs),
    prev: { win: prevWin, metrics: windowTotals(rows, setteoRows, prevWin, paymentsNaiveMs) },
  };
  const partialWeeks = partials.map((win) => ({
    win,
    metrics: windowTotals(rows, setteoRows, win, paymentsNaiveMs),
  }));

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
