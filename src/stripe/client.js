// src/stripe/client.js
// IMPURO. Lector mínimo de Stripe. Dos usos, con DOS niveles de exposición de datos:
//
//   1. `fetchSucceededPaymentTimestamps` — para el REPORTE de EstadoX (§18.B): devuelve
//      SOLO los timestamps de los `succeeded`. Es un conteo; ni montos ni clientes salen
//      de acá. Esta función se mantiene tal cual: el reporte va a un grupo.
//
//   2. `fetchRecentPayments` — para el AVISO DE PAGO a la admin de EstadoX (§18.AD):
//      devuelve id, monto, moneda y el email del recibo. **Excepción consciente** a la
//      regla de arriba: la destinataria es la dueña de esa data (admin de EstadoX) y el
//      aviso va a UN DM, no a un grupo. No usar esta función para nada que se publique.
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

// Pagos `succeeded` desde `createdGteSec`, CON datos (§18.AD — ver la nota de arriba).
// Devuelve [{ id, created, amount, currency, email }]. `amount` viene en la unidad mínima
// de la moneda (centavos): el formateo es cosa del que arma el mensaje.
// La ventana del poller es corta (minutos), así que una sola página alcanza de sobra;
// aun así se pagina por si entran muchos pagos juntos.
export async function fetchRecentPayments({ createdGteSec, fetchImpl = fetch } = {}) {
  const key = STRIPE_API_KEY();
  if (!key) throw new Error('[stripe] falta STRIPE_API_KEY');

  const out = [];
  let startingAfter = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: '100' });
    if (createdGteSec != null) params.set('created[gte]', String(Math.floor(createdGteSec)));
    if (startingAfter) params.set('starting_after', startingAfter);

    const res = await fetchImpl(`${API}?${params}`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`[stripe] pagos ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const data = json?.data || [];
    for (const pi of data) {
      if (pi?.status !== 'succeeded' || pi.created == null) continue;
      out.push({
        id: pi.id,
        created: pi.created,
        amount: pi.amount_received ?? pi.amount ?? null,
        currency: pi.currency || null,
        email: pi.receipt_email || pi.description || null,
      });
    }
    if (!json?.has_more || data.length === 0) return out;
    startingAfter = data[data.length - 1].id;
  }
  return out;
}
