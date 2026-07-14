// src/stripe/alerts.js
// PURO (sin red, sin DB → testeable en Windows). Formatea el aviso de pago que recibe la
// admin de EstadoX cuando entra una venta real (§18.AD).
//
// La señal es el PAGO en Stripe, no lo que dice el closer: un "venta cerrada" en el Push 4
// es la palabra del closer; un PaymentIntent `succeeded` es plata que entró.

// Monedas sin decimales (Stripe las expresa en unidades enteras, no en centavos).
const ZERO_DECIMAL = new Set(['jpy', 'krw', 'clp', 'vnd', 'xaf', 'xof', 'bif', 'djf', 'gnf', 'kmf', 'mga', 'pyg', 'rwf', 'ugx', 'vuv', 'xpf']);

export function formatAmount(amount, currency) {
  if (amount == null || !currency) return null;
  const cur = String(currency).toLowerCase();
  const value = ZERO_DECIMAL.has(cur) ? amount : amount / 100;
  const s = value.toLocaleString('en-US', {
    minimumFractionDigits: ZERO_DECIMAL.has(cur) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `$${s} ${cur.toUpperCase()}`;
}

function formatWhen(createdSec, tz) {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: tz,
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(createdSec * 1000));
}

// Aviso de UN pago. `payment` = { amount, currency, email, created } (de fetchRecentPayments).
export function buildPaymentAlert(payment, { tz = 'America/Bogota', totalHoy = null } = {}) {
  const monto = formatAmount(payment.amount, payment.currency);
  const lineas = [
    `💰 *PAGO RECIBIDO — ESTADOX*`,
    monto ? `*${monto}*` : null,
    payment.email || null,
    formatWhen(payment.created, tz),
  ].filter(Boolean);
  if (totalHoy && totalHoy > 1) lineas.push(`\n_Van ${totalHoy} pagos hoy._`);
  return lineas.join('\n');
}
