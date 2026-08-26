// test/calendly.stuck-sending.test.js
// Regresión de las filas huérfanas en 'sending'.
//
// El bug: `claimCalendlyPush` pasa la fila a 'sending' y `runCalendlyDelivery` la resuelve o la
// revierte… salvo que el proceso muera en el medio. Ahí queda en 'sending' para siempre, porque
// `getDueCalendlyPushes` solo lee 'scheduled'. El push no se entrega y tampoco se entierra: no
// existe más, y sin mirar el dashboard nadie se entera.
//
// Medido en producción el 2026-08-26: ids 3455 (instagram) y 3470 (abogados), 15 horas muertos.
// La causa de fondo no es exótica — el bot reinicia por cada caída de socket de WhatsApp.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';
process.env.CALENDLY_REQUIRE_OPTIN = 'true';
process.env.CALENDLY_DRY_RUN = 'false';

const scheduler = await import('../src/scheduler/calendly.js');
const { installHarness, makeEvent } = await import('./helpers/calendly-harness.js');
const { CLOSERS } = await import('../src/calendly/closers.js');

const OPERACIONES_ET = 'https://api.calendly.com/event_types/8462e92a-8210-4bb2-8e2b-583aa3c3d877';
const CLOSER = { email: 'pablo.lozano@30x.com', phone: CLOSERS['pablo.lozano@30x.com'].phone };
const JID = '111@lid';

function armar(nowMs, startInMin) {
  const h = installHarness(scheduler, {
    nowMs,
    optins: [{ phone: CLOSER.phone, source: 'self', contactJid: JID }],
    events: [
      makeEvent({
        uuid: 'e-huerfano',
        startInMin,
        closerEmail: CLOSER.email,
        eventType: OPERACIONES_ET,
        prospectName: 'Lead Huérfano',
        prospectPhone: '+573001112233',
        nowMs,
      }),
    ],
  });
  scheduler.__setDeps(h.deps);
  return h;
}

test("una fila abandonada en 'sending' se rescata y se entrega en el tick siguiente", async () => {
  const now = Date.parse('2026-08-26T14:00:00Z');
  const { store, wa } = armar(now, 10);

  await scheduler.runCalendlyPoll();
  const row = store._rows.find((r) => r.push_n === 3);
  assert.ok(row, 'se agendó el Push 3');

  // Simula el proceso que murió a mitad de entrega: reclamada y nunca resuelta.
  store.claimCalendlyPush(row.id);
  assert.equal(row.status, 'sending');

  // Sin el rescate, este tick no la vería: getDueCalendlyPushes solo lee 'scheduled'.
  const antes = wa.sent.length;
  await scheduler.runCalendlyDelivery();

  assert.equal(row.status, 'sent', 'la fila rescatada se entregó');
  assert.equal(wa.sent.length, antes + 1, 'el closer recibió su push');
});

test('una fila huérfana cuya llamada YA pasó se entierra con motivo, no queda en limbo', async () => {
  const now = Date.parse('2026-08-26T14:00:00Z');
  const { store, wa, clock } = armar(now, 10);

  await scheduler.runCalendlyPoll();
  const row = store._rows.find((r) => r.push_n === 3);
  store.claimCalendlyPush(row.id);

  // El proceso vuelve DESPUÉS de que la llamada empezó.
  clock.ms = now + 30 * 60000;
  const antes = wa.sent.length;
  await scheduler.runCalendlyDelivery();

  assert.equal(row.status, 'skipped', 'se cerró en vez de quedar en sending');
  assert.equal(row.skip_reason, 'obsoleto');
  assert.equal(wa.sent.length, antes, 'no se mandó un recordatorio de una call que ya pasó');
});

// El rescate solo puede tocar 'sending'. Si algún día alcanzara a una fila ya resuelta, el
// efecto sería un push REPETIDO al closer — el modo de falla contrario y peor.
test('el rescate no resucita filas ya resueltas (sent / skipped)', async () => {
  const now = Date.parse('2026-08-26T14:00:00Z');
  const { store, wa } = armar(now, 10);

  await scheduler.runCalendlyPoll();
  await scheduler.runCalendlyDelivery(); // entrega el Push 3 → queda 'sent'
  const row = store._rows.find((r) => r.push_n === 3);
  assert.equal(row.status, 'sent');
  const enviados = wa.sent.length;

  await scheduler.runCalendlyDelivery(); // el tick siguiente pasa por el rescate
  assert.equal(row.status, 'sent', 'sigue entregada');
  assert.equal(wa.sent.length, enviados, 'no se reenvió nada');
});
