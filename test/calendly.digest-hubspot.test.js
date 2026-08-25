// test/calendly.digest-hubspot.test.js
// §18.AU — el digest Push 1/2 tiene que incluir las citas que solo viven en el CRM.
//
// Tier 1: puro + harness (sin DB nativa, sin red, sin WhatsApp real). El bug que cubre:
// `runDigest` leía SOLO Calendly, así que una cita agendada a mano dentro de HubSpot no
// aparecía en el digest de la noche ni en el de la mañana. Medido el 2026-07-29: el Push 2
// listó 27 citas cuando el día tenía 43 calls vivas — 14 calls de 6 closers sin aviso previo.
//
// Lo que estos tests fijan, en orden de importancia:
//   1. la cita del CRM SÍ sale en el digest;
//   2. la que está en las DOS fuentes sale UNA vez (el riesgo real es mandar dos, no perder una);
//   3. HubSpot caído/apagado no puede costar el digest de Calendly.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';

import * as scheduler from '../src/scheduler/calendly.js';
import { __resetHealth } from '../src/calendly/health.js';
import { installHarness, makeEvent } from './helpers/calendly-harness.js';

const SALAZAR = 'sebastian.salazar@30x.com';
const SALAZAR_PHONE = '+573054312905';

// Hoy en Bogotá (UTC-5): 10:00 local = 15:00Z, 14:00 local = 19:00Z, 16:00 local = 21:00Z.
const hoy = () => {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};
const zulu = (hhmm) => `${hoy()}T${hhmm}:00.000Z`;
// Reloj del digest de la mañana: 06:30 Bogotá = 11:30Z.
const NOW = () => Date.parse(zulu('11:30'));

beforeEach(() => {
  process.env.CALENDLY_DRY_RUN = 'false';
  // Salazar, el closer de fixture de este archivo, pasó a la conexión 'estadox' con la mudanza
  // del Calendly de EstadoX (2026-08-25). Su dry-run es INDEPENDIENTE del de 30x: sin esta línea
  // todos estos escenarios corren mudos y no se entrega nada.
  process.env.CALENDLY_DRY_RUN_ESTADOX = 'false';
  process.env.CALENDLY_REQUIRE_OPTIN = 'true';
  process.env.CALENDLY_PUSH4_ENABLED = 'false';
  process.env.ADMIN_LID = '129446371655733@lid';
  __resetHealth();
  scheduler.__resetDeps();
});

// ─── Fixture: un meeting crudo de HubSpot ─────────────────────────────────────
// Misma forma que devuelve `searchMeetingsInWindow`: el owner se resuelve por id contra
// `ownerEmailById`, y el programa se infiere del TÍTULO (no hay event_type en el CRM).
const OWNER_ID = '77001';
function makeMeeting({
  id = 'm1',
  startZulu,
  title = 'Entrevista de Postulación Programa AI Second Brain',
  ownerId = OWNER_ID,
} = {}) {
  return {
    id,
    properties: {
      hubspot_owner_id: ownerId,
      hs_meeting_title: title,
      hs_meeting_start_time: String(Date.parse(startZulu)),
      hs_createdate: new Date(Date.parse(startZulu) - 36 * 3600000).toISOString(),
    },
  };
}

// Instala el harness y le enchufa la segunda fuente (HubSpot). `meetings` = crudos del CRM;
// `contacts` = { meetingId: { name, phone } }, lo que devuelve getMeetingContact.
function withHubspot(h, { meetings = [], contacts = {}, fail = null } = {}) {
  const calls = { search: 0, contact: [] };
  scheduler.__setDeps({
    ...h.deps,
    hubspotEnabled: () => true,
    async searchMeetingsInWindow() {
      calls.search++;
      if (fail) throw new Error(fail);
      return meetings;
    },
    async getOwnerEmailMap() {
      return { [OWNER_ID]: SALAZAR };
    },
    async getMeetingContact(meetingId) {
      calls.contact.push(meetingId);
      return contacts[meetingId] || null;
    },
  });
  return calls;
}

// ─── 1. La cita que solo vive en el CRM entra al digest ───────────────────────

test('digest Push 2: suma la cita que solo existe en HubSpot', async () => {
  const events = [
    makeEvent({ uuid: 'c1', startIso: zulu('15:00'), closerEmail: SALAZAR, prospectName: 'Ana Gómez' }),
  ];
  const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: NOW() });
  withHubspot(h, {
    meetings: [makeMeeting({ id: 'm1', startZulu: zulu('19:00') })],
    contacts: { m1: { name: 'Beto Ruiz', phone: '+573001112222' } },
  });

  await scheduler.runPush2();

  assert.equal(h.wa.sent.length, 1, 'un solo digest al closer');
  const texto = h.wa.sent[0].text;
  assert.match(texto, /tienes 2 llamadas/, 'cuenta las DOS fuentes');
  assert.match(texto, /Ana Gómez/);
  assert.match(texto, /Beto Ruiz/, 'la cita del CRM aparece por su CONTACTO, no por el título');
  assert.doesNotMatch(texto, /Entrevista de Postulación/, 'el título del meeting no se usa como nombre');
  assert.ok(texto.indexOf('Ana') < texto.indexOf('Beto'), 'el orden por hora se respeta entre fuentes');
});

test('digest Push 2: un closer SIN citas en Calendly igual recibe su digest del CRM', async () => {
  // El caso que más dolía: sin este arreglo, ese closer no recibía NADA en la mañana.
  const h = installHarness(scheduler, { events: [], optins: [SALAZAR_PHONE], nowMs: NOW() });
  withHubspot(h, {
    meetings: [makeMeeting({ id: 'm1', startZulu: zulu('19:00') })],
    contacts: { m1: { name: 'Beto Ruiz', phone: '+573001112222' } },
  });

  await scheduler.runPush2();

  assert.equal(h.wa.sent.length, 1);
  assert.match(h.wa.sent[0].text, /tienes 1 llamada/);
  assert.match(h.wa.sent[0].text, /Beto Ruiz/);
});

// ─── 2. Dedup: el riesgo real es mandar la misma cita dos veces ───────────────

test('digest Push 2: la cita que está en Calendly Y en HubSpot se lista UNA vez', async () => {
  const events = [
    makeEvent({ uuid: 'c1', startIso: zulu('15:00'), closerEmail: SALAZAR, prospectName: 'Ana Gómez' }),
  ];
  const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: NOW() });
  withHubspot(h, {
    // Mismo closer, mismo minuto de arranque → es la MISMA call, sincronizada al CRM.
    meetings: [makeMeeting({ id: 'm1', startZulu: zulu('15:00') })],
    contacts: { m1: { name: 'Ana Gómez', phone: '+573001112222' } },
  });

  await scheduler.runPush2();

  const texto = h.wa.sent[0].text;
  assert.match(texto, /tienes 1 llamada/, 'no se duplica');
  assert.equal(texto.match(/Ana Gómez/g).length, 1);
});

test('digest Push 2: dos registros del CRM para la misma call cuentan una sola vez', async () => {
  // HubSpot guarda varios meetings de una misma cita (caso real: 3 al mismo minuto).
  const h = installHarness(scheduler, { events: [], optins: [SALAZAR_PHONE], nowMs: NOW() });
  withHubspot(h, {
    meetings: [
      makeMeeting({ id: 'm1', startZulu: zulu('19:00') }),
      makeMeeting({ id: 'm2', startZulu: zulu('19:00') }),
    ],
    contacts: { m1: { name: 'Beto Ruiz', phone: '+573001112222' } },
  });

  await scheduler.runPush2();
  assert.match(h.wa.sent[0].text, /tienes 1 llamada/);
});

// ─── 3. Guardarraíles heredados de agenda-poll.js ─────────────────────────────

test('digest Push 2: un programa de OTRA empresa no entra por el CRM de esta', async () => {
  // Retia (tactical_investor) tiene su propio Calendly y no vive en este HubSpot. Si colara,
  // le meteríamos a un closer una cita de otra agencia.
  const h = installHarness(scheduler, { events: [], optins: [SALAZAR_PHONE], nowMs: NOW() });
  withHubspot(h, {
    meetings: [
      makeMeeting({ id: 'm1', startZulu: zulu('19:00'), title: 'Sesión De Cero a Tactical Investor' }),
    ],
    contacts: { m1: { name: 'Beto Ruiz', phone: '+573001112222' } },
  });

  await scheduler.runPush2();
  assert.equal(h.wa.sent.length, 0, 'sin citas propias no hay digest');
});

test('digest Push 2: un meeting sin naming de programa (interna) no entra', async () => {
  const h = installHarness(scheduler, { events: [], optins: [SALAZAR_PHONE], nowMs: NOW() });
  withHubspot(h, {
    meetings: [makeMeeting({ id: 'm1', startZulu: zulu('19:00'), title: 'Reunión de equipo' })],
  });

  await scheduler.runPush2();
  assert.equal(h.wa.sent.length, 0);
});

test('digest Push 2: un owner que no es closer nuestro no entra', async () => {
  const h = installHarness(scheduler, { events: [], optins: [SALAZAR_PHONE], nowMs: NOW() });
  withHubspot(h, {
    meetings: [makeMeeting({ id: 'm1', startZulu: zulu('19:00'), ownerId: '99999' })],
  });

  await scheduler.runPush2();
  assert.equal(h.wa.sent.length, 0);
});

// ─── 4. La segunda fuente no puede costar el digest ───────────────────────────

test('digest Push 2: HubSpot caído → el digest de Calendly sale igual', async () => {
  const events = [
    makeEvent({ uuid: 'c1', startIso: zulu('15:00'), closerEmail: SALAZAR, prospectName: 'Ana Gómez' }),
  ];
  const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: NOW() });
  withHubspot(h, { fail: 'HubSpot 500' });

  await scheduler.runPush2();

  assert.equal(h.wa.sent.length, 1, 'el digest se manda igual');
  assert.match(h.wa.sent[0].text, /tienes 1 llamada/);
  assert.match(h.wa.sent[0].text, /Ana Gómez/);
});

test('digest Push 2: sin HubSpot configurado se comporta exactamente como antes', async () => {
  const events = [
    makeEvent({ uuid: 'c1', startIso: zulu('15:00'), closerEmail: SALAZAR, prospectName: 'Ana Gómez' }),
  ];
  // installHarness NO inyecta searchMeetingsInWindow → la segunda fuente se autodesactiva.
  const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: NOW() });

  await scheduler.runPush2();

  assert.equal(h.wa.sent.length, 1);
  assert.match(h.wa.sent[0].text, /tienes 1 llamada/);
});

test('digest Push 2: Calendly caído entero NO manda un digest a medias', async () => {
  // Un conteo incompleto que se lee como completo es peor que no mandar: el closer creería
  // que su día son las 2 citas del CRM cuando tiene 8.
  const h = installHarness(scheduler, {
    events: [],
    optins: [SALAZAR_PHONE],
    nowMs: NOW(),
    api: { throwError: 'Calendly 401: token inválido' },
  });
  withHubspot(h, {
    meetings: [makeMeeting({ id: 'm1', startZulu: zulu('19:00') })],
    contacts: { m1: { name: 'Beto Ruiz', phone: '+573001112222' } },
  });

  await scheduler.runPush2();
  const digests = h.wa.sent.filter((m) => m.to !== '129446371655733@lid');
  assert.equal(digests.length, 0, 'ningún digest mientras Calendly esté caído');
});

// ─── 5. Push 1 (la noche anterior) usa el mismo camino ────────────────────────

test('digest Push 1 (mañana): también suma las citas del CRM', async () => {
  const t = new Date(Date.now() + 86400000);
  const manana = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  const start = `${manana}T19:00:00.000Z`;
  // Reloj: 19:00 Bogotá de hoy = 00:00Z de mañana... se fija explícito para no depender del huso.
  const h = installHarness(scheduler, { events: [], optins: [SALAZAR_PHONE], nowMs: Date.parse(zulu('23:00')) });
  withHubspot(h, {
    meetings: [makeMeeting({ id: 'm1', startZulu: start })],
    contacts: { m1: { name: 'Carla Díaz', phone: '+573001112222' } },
  });

  await scheduler.runPush1();

  assert.equal(h.wa.sent.length, 1);
  assert.match(h.wa.sent[0].text, /Push 1/);
  assert.match(h.wa.sent[0].text, /Carla Díaz/);
});
