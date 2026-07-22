// test/calendly.push3-phone-refresh.test.js
// Regresión del cross-check de teléfono en el Push 3 (§ fallback HubSpot).
//
// El bug: el mensaje del Push 3 se ARMA en el poll y congela `prospect_phone`. Si en ese
// instante Calendly no traía número Y HubSpot aún no tenía el contacto, la fila quedaba
// "sin teléfono — mándalo manual" PARA SIEMPRE. El digest Push 1/2 re-resuelve en vivo cada
// mañana (por eso ahí SÍ salía el número), pero el Push 3 usaba el valor viejo. Caso real:
// Carlos Alvarado — número en Push 2, "sin teléfono" en Push 3, misma cita.
//
// El fix re-resuelve el teléfono AL ENTREGAR el Push 3/0 cuando sigue vacío, y solo entonces
// (cero llamadas extra a HubSpot en el caso normal). Estos escenarios blindan las 3 ramas:
// se sana, no regresiona el "manual", y no pega a HubSpot de más.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';
process.env.CALENDLY_REQUIRE_OPTIN = 'true';
process.env.CALENDLY_DRY_RUN = 'false'; // la cuenta 30x va EN VIVO, como en producción
process.env.ADMIN_LID = '129446371655733@lid'; // sin admins, notifyAdmins solo loguea

const scheduler = await import('../src/scheduler/calendly.js');
const { installHarness, makeEvent } = await import('./helpers/calendly-harness.js');
const { CLOSERS } = await import('../src/calendly/closers.js');

// Operaciones Escalables con IA — el programa de la cita real de Carlos (tiene copy → link wa.me).
const OPERACIONES_ET = 'https://api.calendly.com/event_types/8462e92a-8210-4bb2-8e2b-583aa3c3d877';
// Closer real del roster 30x (su cuenta es la conectada al HubSpot → el fallback aplica).
const CLOSER = { email: 'pablo.lozano@30x.com', phone: CLOSERS['pablo.lozano@30x.com'].phone };
const JID = '111@lid';

// startInMin 20 → el `due` del Push 3 (start − 25) ya pasó → catch-up: vence de una,
// así el mismo escenario agenda (poll) y entrega (delivery) sin saltar el reloj.
function armar({ nowMs, prospectPhone, getContactPhone }) {
  const h = installHarness(scheduler, {
    nowMs,
    optins: [{ phone: CLOSER.phone, source: 'self', contactJid: JID }],
    events: [
      makeEvent({
        uuid: 'e-carlos',
        startInMin: 20,
        closerEmail: CLOSER.email,
        eventType: OPERACIONES_ET,
        prospectName: 'Carlos Alvarado',
        prospectPhone,
        prospectEmail: 'carlos@ejemplo.com',
        nowMs,
      }),
    ],
  });
  h.deps.hubspotEnabled = () => true;
  if (getContactPhone) h.deps.getContactPhone = getContactPhone;
  scheduler.__setDeps(h.deps);
  return h;
}

test('Push 3: Calendly sin número pero HubSpot lo tiene al ENTREGAR → el push sale con el número', async () => {
  const now = Date.parse('2026-07-22T14:00:00Z');
  let hubspotPhone = null; // al agendar, HubSpot todavía no tiene el teléfono del contacto
  const { store, wa } = armar({
    nowMs: now,
    prospectPhone: null, // Calendly SIN número (instant_book / reagenda / formulario sin SMS)
    getContactPhone: async () => hubspotPhone,
  });

  // 1) Poll: agenda el Push 3. HubSpot aún vacío → la fila queda congelada "sin teléfono".
  await scheduler.runCalendlyPoll();
  const row = store._rows.find((r) => r.push_n === 3);
  assert.ok(row, 'se agendó el Push 3');
  assert.equal(row.prospect_phone, null, 'la fila quedó sin teléfono (Calendly y HubSpot vacíos al agendar)');
  assert.match(row.message, /sin teléfono en Calendly/, 'el mensaje congelado invita a mandarlo manual');

  // 2) El contacto entra a HubSpot con su teléfono (el closer lo enriqueció después de agendar).
  hubspotPhone = '+573009999999';

  // 3) Entrega: el fix re-resuelve el teléfono en vivo → el push sale CON número.
  await scheduler.runCalendlyDelivery();

  assert.equal(wa.sent.length, 1, 'salió el push al closer');
  assert.equal(wa.sent[0].to, JID, 'fue al hilo del closer');
  assert.doesNotMatch(wa.sent[0].text, /sin teléfono en Calendly/, 'ya NO dice "mándalo manual"');
  assert.match(wa.sent[0].text, /wa\.me\/573009999999/, 'el link precall lleva el número recuperado de HubSpot');

  scheduler.__resetDeps();
});

test('Push 3: si HubSpot TAMPOCO tiene número al entregar → cae a manual (sin regresión)', async () => {
  const now = Date.parse('2026-07-22T14:00:00Z');
  const { wa } = armar({
    nowMs: now,
    prospectPhone: null,
    getContactPhone: async () => null, // nunca aparece el número
  });

  await scheduler.runCalendlyPoll();
  await scheduler.runCalendlyDelivery();

  assert.equal(wa.sent.length, 1, 'el push igual sale (informativo)');
  assert.match(wa.sent[0].text, /sin teléfono en Calendly/, 'sigue siendo "mándalo manual", exactamente como antes');

  scheduler.__resetDeps();
});

test('Push 3: con número directo de Calendly, la entrega NO consulta HubSpot', async () => {
  const now = Date.parse('2026-07-22T14:00:00Z');
  let consultas = 0;
  const { wa } = armar({
    nowMs: now,
    prospectPhone: '+573001112222', // Calendly SÍ trae número
    getContactPhone: async () => {
      consultas++;
      return '+573009999999';
    },
  });

  await scheduler.runCalendlyPoll();
  await scheduler.runCalendlyDelivery();

  assert.equal(consultas, 0, 'con número directo no se toca HubSpot (ni al agendar ni al entregar)');
  assert.equal(wa.sent.length, 1, 'salió el push');
  assert.match(wa.sent[0].text, /wa\.me\/573001112222/, 'usa el número directo de Calendly');

  scheduler.__resetDeps();
});
