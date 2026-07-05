// src/stripe/client.js
// IMPURO. Único archivo del módulo que toca la red. Lee los PaymentIntents de Stripe
// vía REST (SIN el SDK de `stripe` — un `fetch` a la API v1 basta y evita una
// dependencia nueva).
//
// Autenticación: `STRIPE_API_KEY` en el header `Authorization: Bearer`. Usar una
// RESTRICTED KEY de solo lectura (rk_live_…) con permiso "read" sobre PaymentIntents;
// NUNCA la secret key completa (sk_live_…). El reporte solo lee.

import { windowToUnixSeconds, countPaid } from './count.js';

const API = 'https://api.stripe.com/v1/payment_intents';

export const STRIPE_API_KEY = () => (process.env.STRIPE_API_KEY || '').trim();

// Trae TODOS los PaymentIntents con `created` en [startSec, endSec) paginando hasta
// agotar `has_more`. Stripe no permite filtrar por `status` en el listado, así que
// bajamos todos los de la ventana y el conteo de `succeeded` se hace en count.js.
// El volumen de ventas/día es bajo → la paginación es trivial (page=100).
async function fetchIntents({ startSec, endSec, apiKey = STRIPE_API_KEY() }) {
  if (!apiKey) throw new Error('[stripe] falta STRIPE_API_KEY');

  const out = [];
  let startingAfter = null;
  // Tope de páginas defensivo: 100 páginas × 100 = 10k intents. Muy por encima de lo
  // esperado; evita un bucle infinito si `has_more` viniera mal.
  for (let page = 0; page < 100; page++) {
    const qs = new URLSearchParams({ limit: '100' });
    qs.set('created[gte]', String(startSec));
    qs.set('created[lt]', String(endSec));
    if (startingAfter) qs.set('starting_after', startingAfter);

    const res = await fetch(`${API}?${qs}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`[stripe] payment_intents ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = await res.json();
    const data = body.data || [];
    out.push(...data);
    if (!body.has_more || data.length === 0) break;
    startingAfter = data[data.length - 1].id;
  }
  return out;
}

// API de alto nivel para el reporte: dada la ventana MÁS AMPLIA (naive, hora Bogotá)
// que abarca hoy + los días del promedio, baja los intents UNA sola vez y los
// devuelve crudos para que count.js bucketice cada día sin re-pedir a la red.
// Devuelve { intents, startSec, endSec } (los segundos UTC ya convertidos).
export async function fetchPaidIntents(span, { now = new Date(), tz } = {}) {
  const { startSec, endSec } = windowToUnixSeconds(span, now, tz);
  const intents = await fetchIntents({ startSec, endSec });
  return { intents, startSec, endSec };
}

export { countPaid, windowToUnixSeconds };
