// src/stripe/count.js
// PURO. Cuenta las ventas REALES de EstadoX a partir de PaymentIntents de Stripe.
//
// Una venta = un PaymentIntent en estado `succeeded` (self-checkout de pago único:
// Payment Link o Checkout Session → siempre generan un PaymentIntent). La cuenta es
// SOLO de EstadoX (así lo confirmó el dueño), así que no hace falta filtrar por
// producto/precio: todo cobro exitoso cuenta. Esto reemplaza el `pagaron:` que hoy
// sale de un tag manual en el Sheet (fuente de los falsos positivos).
//
// ⚠️ Zonas horarias: la ventana del reporte (`window.js`) usa epoch "naive" (hora de
// pared de Bogotá metida en Date.UTC). Stripe sella `created` en epoch UTC real. Para
// comparar, convertimos los límites naive → UTC real restándoles el offset de Bogotá
// (constante −5h; Colombia no tiene horario de verano), derivado con Intl para no
// hardcodear el número.

import { zonedParts, computeWindow } from '../sheets/window.js';

const DAY_MS = 24 * 3600 * 1000;

// Offset (en ms) de la zona `tz` en el instante `at`: local − UTC. Para Bogotá = −5h.
// Se calcula con las mismas piezas zonificadas que usa el módulo de Sheets, así que
// no introduce una fuente de verdad nueva sobre la zona.
export function tzOffsetMs(at, tz = 'America/Bogota') {
  const p = zonedParts(at, tz);
  const wallAsUtc = Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, p.S);
  return wallAsUtc - at.getTime();
}

// Traduce la ventana naive {startMs, endMs} (hora de pared de Bogotá) a segundos UTC
// reales, que es lo que compara Stripe. `now` fija el offset de la zona (constante en
// Bogotá, pero lo derivamos por si el TZ del deploy fuera otro).
export function windowToUnixSeconds({ startMs, endMs }, now = new Date(), tz = 'America/Bogota') {
  const off = tzOffsetMs(now, tz); // real = naive − offset
  return {
    startSec: Math.floor((startMs - off) / 1000),
    endSec: Math.floor((endMs - off) / 1000),
  };
}

// Cuenta los PaymentIntents `succeeded` cuyo `created` cae en [startSec, endSec).
// Filtra también por ventana (aunque el cliente ya la pide a Stripe) para que la
// misma lista sirva para bucketizar varios días (hoy + promedio previo) sin re-pedir.
// Devuelve la cuenta y el monto cobrado en centavos (disponible para el futuro; hoy
// el reporte solo muestra la cuenta).
export function countPaid(intents, { startSec, endSec }) {
  let paid = 0;
  let amountCents = 0;
  for (const pi of intents || []) {
    if (!pi || pi.status !== 'succeeded') continue;
    const c = Number(pi.created);
    if (!Number.isFinite(c) || c < startSec || c >= endSec) continue;
    paid += 1;
    amountCents += Number(pi.amount_received ?? pi.amount ?? 0);
  }
  return { paid, amountCents };
}

// Desde la MISMA lista de intents (ya bajada una vez), cuenta el pago de HOY y
// promedia los `days` días PREVIOS (excluye hoy) — espeja averagePriorDays() de
// Sheets pero sobre pagos reales. Reusa las ventanas diarias de Bogotá de window.js
// y las convierte a segundos UTC para comparar con Stripe. Puro (sin red).
export function paidTodayAndAvg(intents, now = new Date(), { days = 7, tz } = {}) {
  const today = countPaid(intents, windowToUnixSeconds(computeWindow(now), now, tz)).paid;
  let prior = 0;
  for (let k = 1; k <= days; k++) {
    const win = windowToUnixSeconds(computeWindow(new Date(now.getTime() - k * DAY_MS)), now, tz);
    prior += countPaid(intents, win).paid;
  }
  return { today, avgPrior: prior / days, days };
}
