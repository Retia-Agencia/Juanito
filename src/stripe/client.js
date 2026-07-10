// src/stripe/client.js
// IMPURO. Lector mínimo de Stripe para el reporte de EstadoX (§18.B): lista los
// PaymentIntents y devuelve SOLO los timestamps (`created`, epoch segundos) de los
// `succeeded` — montos y datos del cliente nunca salen de este módulo.
//
// Sin SDK a propósito (regla del repo: no sumar dependencias): fetch nativo contra
// la REST API con la restricted key de solo-lectura (rk_…, permiso "read" sobre
// PaymentIntents). La cuenta solo cobra EstadoX → no hace falta filtrar por producto.

const API = 'https://api.stripe.com/v1/payment_intents';
const MAX_PAGES = 10; // tope de seguridad: 10 × 100 intents cubre 35 días con margen

export const STRIPE_API_KEY = () => (process.env.STRIPE_API_KEY || '').trim();

// Timestamps `created` (epoch SEGUNDOS, UTC real) de los PaymentIntents `succeeded`
// desde `createdGteSec`. Pagina con has_more/starting_after; la API no filtra por
// status, así que se filtra acá. Errores → throw; el caller decide el fallback.
export async function fetchSucceededPaymentTimestamps({ createdGteSec, fetchImpl = fetch } = {}) {
  const key = STRIPE_API_KEY();
  if (!key) throw new Error('[stripe] falta STRIPE_API_KEY');

  const created = [];
  let startingAfter = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: '100' });
    if (createdGteSec != null) params.set('created[gte]', String(Math.floor(createdGteSec)));
    if (startingAfter) params.set('starting_after', startingAfter);

    const res = await fetchImpl(`${API}?${params}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`[stripe] pagos ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const data = json?.data || [];
    for (const pi of data) {
      if (pi?.status === 'succeeded' && pi.created != null) created.push(pi.created);
    }
    if (!json?.has_more || data.length === 0) return created;
    startingAfter = data[data.length - 1].id;
  }
  console.warn(`[stripe] corté la paginación en ${MAX_PAGES} páginas; el conteo podría quedar corto`);
  return created;
}
