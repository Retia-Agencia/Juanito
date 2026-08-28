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

import { fetchConDeadline } from '../common/http.js';

const API = 'https://api.stripe.com/v1/payment_intents';
const SESSIONS_API = 'https://api.stripe.com/v1/checkout/sessions';
const CHARGES_API = 'https://api.stripe.com/v1/charges';
const MAX_PAGES = 10; // tope de seguridad: 10 × 100 intents cubre 35 días con margen
// El bloque de venta neta mira DOS meses hacia atrás (MTD + el MTD anterior), así que
// necesita más páginas que las funciones diarias. 20 × 100 = 2000 cargos en ~62 días.
const MAX_PAGES_CHARGES = 20;

export const STRIPE_API_KEY = () => (process.env.STRIPE_API_KEY || '').trim();

// Timestamps `created` (epoch SEGUNDOS, UTC real) de los PaymentIntents `succeeded`
// desde `createdGteSec`. Pagina con has_more/starting_after; la API no filtra por
// status, así que se filtra acá. Errores → throw; el caller decide el fallback.
export async function fetchSucceededPaymentTimestamps({ createdGteSec, fetchImpl = fetchConDeadline } = {}) {
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
export async function fetchRecentPayments({ createdGteSec, fetchImpl = fetchConDeadline } = {}) {
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

// Cargos (`/v1/charges`) desde `createdGteSec`, CON montos — para la línea de VENTA NETA
// del reporte (§18.B, 2026-08-12). Tercera excepción consciente a la regla de arriba: son
// AGREGADOS (se suman y se muestra un total por moneda, sin cliente ni id), y el bloque
// que los usa sale SOLO por DM, nunca al grupo.
//
// Por qué charges y no payment_intents: "neta" = cobros − reembolsos, y el reembolso vive
// en el CARGO (`amount_refunded`). El PaymentIntent no lo expone sin expandir `latest_charge`,
// lo que igual exigiría el mismo permiso.
//
// ⚠️ Requiere que la restricted key tenga permiso "read" sobre **Charges** (además de
// PaymentIntents y Checkout Sessions). Sin él, Stripe devuelve 403 → throw → el caller
// omite el bloque y el reporte sale igual.
//
// `amount_refunded` atribuye el reembolso a la fecha del cargo ORIGINAL: un reembolso de
// agosto sobre una venta de julio baja el número de julio. Es a propósito (venta neta por
// fecha de cobro) y el mensaje lo dice al pie.
//
// Expande `balance_transaction` porque la cuenta NO cobra solo en dólares (verificado en
// producción 2026-08-12: 67 cargos en usd y 4 en cop en 45 días) pero SÍ liquida en USD.
// La balance transaction trae el monto ya convertido y la tasa que Stripe aplicó de verdad
// (`exchange_rate`), así que el reporte unifica todo en dólares sin inventar una tasa de
// mercado ni sumar una dependencia de FX. `amount` de la bt es BRUTO (antes de comisión);
// `net` sería después — usamos `amount`, que es la definición de "neta" que se eligió.
// Si la expansión no viene (permiso faltante, bt todavía pendiente), los campos `settled*`
// quedan en null y el agregador cae a la moneda original del cargo.
export async function fetchChargesSince({ createdGteSec, fetchImpl = fetchConDeadline } = {}) {
  const key = STRIPE_API_KEY();
  if (!key) throw new Error('[stripe] falta STRIPE_API_KEY');

  const out = [];
  let startingAfter = null;
  for (let page = 0; page < MAX_PAGES_CHARGES; page++) {
    const params = new URLSearchParams({ limit: '100' });
    if (createdGteSec != null) params.set('created[gte]', String(Math.floor(createdGteSec)));
    if (startingAfter) params.set('starting_after', startingAfter);
    params.append('expand[]', 'data.balance_transaction');

    const res = await fetchImpl(`${CHARGES_API}?${params}`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`[stripe] charges ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const data = json?.data || [];
    for (const ch of data) {
      if (ch?.created == null) continue;
      // Sin expandir, `balance_transaction` es un string (id) y no sirve para convertir.
      const bt = ch.balance_transaction;
      const settled = bt && typeof bt === 'object' ? bt : null;
      out.push({
        created: ch.created,
        amount: ch.amount ?? 0,
        amountRefunded: ch.amount_refunded ?? 0,
        currency: ch.currency || null,
        status: ch.status || null,
        settledAmount: settled?.amount ?? null,
        settledCurrency: settled?.currency ?? null,
        // null cuando no hubo conversión (el cargo ya estaba en la moneda de liquidación).
        exchangeRate: settled?.exchange_rate ?? null,
      });
    }
    if (!json?.has_more || data.length === 0) return out;
    startingAfter = data[data.length - 1].id;
  }
  console.warn(
    `[stripe] corté la paginación de charges en ${MAX_PAGES_CHARGES} páginas; la venta neta podría quedar corta`
  );
  return out;
}

// Timestamps `created` (epoch SEGUNDOS, UTC real) de los PaymentIntents `succeeded` que
// nacieron de UN Payment Link. Es un conteo, como `fetchSucceededPaymentTimestamps`: ni
// montos ni clientes salen de acá.
//
// Por qué pasa por Checkout Sessions: el PaymentIntent no guarda de qué link vino — esa
// relación solo vive en la Session. Se listan las sessions del link y se expande su PI.
//
// ⚠️ Devuelve el `created` del PAYMENT INTENT, no el de la Session, y filtra por el status
// del PI (no por `payment_status` de la Session). Las dos cosas son a propósito:
//   - La Session nace al abrir el carrito y el PI se paga 3-6 min después (medido sobre la
//     cuenta real). Con el reloj de la Session, un pago iniciado 7:57pm y pagado 8:01pm
//     caería en un día distinto al que le da `fetchSucceededPaymentTimestamps`.
//   - Mismo predicado (`status === 'succeeded'`) que esa función ⇒ lo que sale de acá es
//     por construcción un SUBCONJUNTO de lo que sale de allá, y la resta que hace el
//     reporte ("total − self-checkout") nunca puede dar negativo.
//
// `createdGteSec` filtra por el `created` de la SESSION, que es anterior al del PI. El
// caller debe pedir con margen hacia atrás (una Session de payment link expira a las 24h,
// así que el PI nunca se aleja más de eso) y luego filtrar por ventana con lo devuelto.
export async function fetchSucceededPaymentTimestampsForLink({
  paymentLink,
  createdGteSec,
  fetchImpl = fetchConDeadline,
} = {}) {
  const key = STRIPE_API_KEY();
  if (!key) throw new Error('[stripe] falta STRIPE_API_KEY');
  if (!paymentLink) throw new Error('[stripe] falta paymentLink');

  const created = [];
  let startingAfter = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: '100', payment_link: paymentLink });
    params.append('expand[]', 'data.payment_intent');
    if (createdGteSec != null) params.set('created[gte]', String(Math.floor(createdGteSec)));
    if (startingAfter) params.set('starting_after', startingAfter);

    const res = await fetchImpl(`${SESSIONS_API}?${params}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`[stripe] sessions ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const data = json?.data || [];
    for (const s of data) {
      const pi = s?.payment_intent;
      // Sin expandir (string) no hay forma de saber su `created` → se ignora antes que
      // contarlo con el reloj equivocado.
      if (pi && typeof pi === 'object' && pi.status === 'succeeded' && pi.created != null) {
        created.push(pi.created);
      }
    }
    if (!json?.has_more || data.length === 0) return created;
    startingAfter = data[data.length - 1].id;
  }
  console.warn(
    `[stripe] corté la paginación de sessions en ${MAX_PAGES} páginas; el conteo del link podría quedar corto`
  );
  return created;
}
