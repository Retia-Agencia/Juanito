// test/stripe.alerts.test.js
// Tests del aviso de pago a la admin de EstadoX (§18.AD). Puros: el poller se prueba con
// deps inyectadas (sin red, sin DB, sin WhatsApp) → corre en Windows.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { buildPaymentAlert, formatAmount } = await import('../src/stripe/alerts.js');
const { runStripeAlerts } = await import('../src/scheduler/stripe-alerts.js');

const NOW = new Date('2026-07-14T20:42:00Z'); // 3:42pm Bogotá
const PAGO = { id: 'pi_1', created: Math.floor(NOW.getTime() / 1000), amount: 120000, currency: 'usd', email: 'ana.perez@gmail.com' };

beforeEach(() => {
  process.env.TZ = 'America/Bogota';
  process.env.STRIPE_API_KEY = 'rk_test_x';
  process.env.STRIPE_ALERT_JIDS = '573001112233@s.whatsapp.net';
  delete process.env.STRIPE_ALERT_LOOKBACK_MIN;
});

// Harness: DB + Stripe + WA en memoria.
function harness({ pagos = [PAGO], seeded = true, conHilo = true } = {}) {
  const settings = seeded ? { stripe_alerts_seeded: '2026-07-01' } : {};
  const vistos = new Set();
  const sent = [];
  return {
    sent,
    settings,
    deps: {
      fetchRecentPayments: async () => pagos,
      sendMessage: async (to, text) => sent.push({ to, text }),
      markIfNew: (k) => (vistos.has(k) ? false : (vistos.add(k), true)),
      hasDmThread: () => conHilo,
      getSetting: (k) => settings[k] ?? null,
      setSetting: (k, v) => (settings[k] = v),
    },
  };
}

test('formatAmount: centavos → moneda legible', () => {
  assert.equal(formatAmount(120000, 'usd'), '$1,200.00 USD');
  assert.equal(formatAmount(4500000, 'cop'), '$45,000.00 COP');
  assert.equal(formatAmount(null, 'usd'), null);
});

test('el aviso trae monto, cliente y hora local', () => {
  const msg = buildPaymentAlert(PAGO, { tz: 'America/Bogota' });
  assert.match(msg, /PAGO RECIBIDO — ESTADOX/);
  assert.match(msg, /\$1,200\.00 USD/);
  assert.match(msg, /ana\.perez@gmail\.com/);
  assert.match(msg, /3:42/); // 20:42 UTC = 3:42pm Bogotá
});

test('un pago nuevo → un aviso', async () => {
  const h = harness();
  const n = await runStripeAlerts({ now: NOW, deps: h.deps });
  assert.equal(n, 1);
  assert.equal(h.sent[0].to, '573001112233@s.whatsapp.net');
  assert.match(h.sent[0].text, /\$1,200\.00 USD/);
});

test('el mismo pago no se avisa dos veces (dedup por PaymentIntent)', async () => {
  const h = harness();
  await runStripeAlerts({ now: NOW, deps: h.deps });
  const n2 = await runStripeAlerts({ now: NOW, deps: h.deps }); // el cron corre otra vez
  assert.equal(n2, 0, 'el segundo tick no reenvía');
  assert.equal(h.sent.length, 1);
});

// EL guard que importa: escribirle en frío a alguien que nunca habló con Juanito es
// exactamente el patrón que provocó el softban anterior.
test('ANTI-BAN: sin hilo previo NO se envía nada', async () => {
  const h = harness({ conHilo: false });
  const n = await runStripeAlerts({ now: NOW, deps: h.deps });
  assert.equal(n, 0);
  assert.equal(h.sent.length, 0, 'Juanito no escribe en frío');
});

// Sin esto, al desplegar la feature saldría una ráfaga con las últimas 2 horas de pagos.
test('arranque en frío: la 1ª corrida marca los pagos existentes SIN avisar', async () => {
  const h = harness({ seeded: false, pagos: [PAGO, { ...PAGO, id: 'pi_2' }] });
  const n = await runStripeAlerts({ now: NOW, deps: h.deps });
  assert.equal(n, 0, 'no avisa los viejos');
  assert.equal(h.sent.length, 0);
  assert.ok(h.settings.stripe_alerts_seeded, 'quedó sembrado');

  // Y a partir de ahí, un pago NUEVO sí avisa.
  h.deps.fetchRecentPayments = async () => [PAGO, { ...PAGO, id: 'pi_2' }, { ...PAGO, id: 'pi_3' }];
  const n2 = await runStripeAlerts({ now: NOW, deps: h.deps });
  assert.equal(n2, 1);
  assert.equal(h.sent.length, 1);
});

test('sin destinatarios configurados el job no hace nada', async () => {
  process.env.STRIPE_ALERT_JIDS = '';
  const h = harness();
  assert.equal(await runStripeAlerts({ now: NOW, deps: h.deps }), 0);
});

test('si Stripe se cae, no truena (degrada en silencio)', async () => {
  const h = harness();
  h.deps.fetchRecentPayments = async () => {
    throw new Error('[stripe] pagos 500');
  };
  assert.equal(await runStripeAlerts({ now: NOW, deps: h.deps }), 0);
});
