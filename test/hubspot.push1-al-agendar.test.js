// test/hubspot.push1-al-agendar.test.js
// §18.CP — el Push 1 al agendar también para las reuniones de HubSpot (el assigner de 30X).
//
// Tier 1: harness (sin DB nativa, sin red, sin WhatsApp real). El bug que cubre: el barrido de la
// prueba §18.CK solo leía Calendly, así que una cita que el assigner agendaba directo en HubSpot a
// más de 48h recibía su Push 1 en la víspera (caso real: Lucas Mendoza, 14-oct). Lo que se fija:
//   1. la reunión recién creada a días de distancia recibe su Push 0 y la víspera la salta;
//   2. no duplica: misma cita en Calendly, dos registros del mismo minuto, el poll de <48h;
//   3. una reagenda no es una reserva nueva;
//   4. el Push 0 solo no le quita a la cita su Push 3 cuando entra a las 48h;
//   5. prueba vencida → ni una request.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';

import * as scheduler from '../src/scheduler/calendly.js';
import { __resetHealth } from '../src/calendly/health.js';
import { accountOf } from '../src/calendly/accounts.js';
import { installHarness } from './helpers/calendly-harness.js';

// Closer de fixture del harness (conexión 'estadox').
const SALAZAR = 'sebastian.salazar@30x.com';
const SALAZAR_PHONE = '+573054312905';
const OWNER_ID = '77001';
const ESTADOX = [accountOf('estadox')];

const NOW = Date.parse('2026-10-14T15:00:00Z'); // miércoles 14, 10:00 Bogotá
const SABADO = '2026-10-17T15:00:00Z'; // sábado 17, 10:00 Bogotá: fuera de las 48h del poll
const dbUtc = (iso) => iso.slice(0, 19).replace('T', ' ');
const msOf = (s) => Date.parse(`${String(s).replace(' ', 'T')}Z`);

const meeting = ({ id = 'm1', startIso = SABADO, createdMin = -2, title = 'Agendamiento — second-brain — Sebastián' }) => ({
  id,
  properties: {
    hubspot_owner_id: OWNER_ID,
    hs_meeting_title: title,
    hs_meeting_start_time: String(Date.parse(startIso)),
    hs_createdate: new Date(NOW + createdMin * 60000).toISOString(),
  },
});

beforeEach(() => {
  process.env.CALENDLY_DRY_RUN = 'false';
  process.env.CALENDLY_DRY_RUN_ESTADOX = 'false';
  process.env.CALENDLY_REQUIRE_OPTIN = 'true';
  process.env.CALENDLY_PUSH4_ENABLED = 'false';
  process.env.ADMIN_LID = '129446371655733@lid';
  process.env.HUBSPOT_AGENDA_POLL = 'true';
  process.env.CALENDLY_PUSH1_AL_AGENDAR = 'estadox';
  process.env.CALENDLY_PUSH1_AL_AGENDAR_HASTA = '2026-10-23';
  __resetHealth();
  scheduler.__resetDeps();
});
afterEach(() => {
  for (const k of ['HUBSPOT_AGENDA_POLL', 'CALENDLY_PUSH1_AL_AGENDAR', 'CALENDLY_PUSH1_AL_AGENDAR_HASTA', 'HUBSPOT_FUENTE_CONEXIONES']) {
    delete process.env[k];
  }
});

// `creadas` = lo que devuelve searchMeetingsCreatedSince; `enVentana` = searchMeetingsInWindow
// (poll y digest); `contactos` = { meetingId: contactId } y `deContacto` = { contactId: [ids] }.
function conHubspot(h, { creadas = [], enVentana = [], contactos = {}, deContacto = {}, todas = [], marcadas = new Set() } = {}) {
  const llamadas = { creadas: 0 };
  scheduler.__setDeps({
    ...h.deps,
    accounts: () => ESTADOX,
    hubspotEnabled: () => true,
    async getOwnerEmailMap() {
      return { [OWNER_ID]: SALAZAR };
    },
    async searchMeetingsCreatedSince() {
      llamadas.creadas++;
      return creadas;
    },
    async searchMeetingsInWindow() {
      return enVentana;
    },
    async getMeetingContact() {
      return { name: 'Henry Contreras', phone: '+573001112222' };
    },
    async getContactsOfMeetings(ids) {
      return Object.fromEntries(ids.filter((id) => contactos[id]).map((id) => [id, contactos[id]]));
    },
    async getMeetingsOfContacts(cids) {
      return Object.fromEntries(cids.map((c) => [c, deContacto[c] || []]));
    },
    async getMeetingsByIds(ids) {
      return todas.filter((m) => ids.includes(m.id));
    },
    // Mismo contrato que el SQL de src/db/index.js, incluido `solo_push0`.
    getCallsWithAnyPushInWindow(from, to) {
      const porUuid = new Map();
      for (const r of h.store._rows) {
        if (msOf(r.call_start) < msOf(from) || msOf(r.call_start) >= msOf(to)) continue;
        const c = porUuid.get(r.event_uuid) || { event_uuid: r.event_uuid, closer_email: r.closer_email, call_start: r.call_start, solo_push0: 1 };
        if (r.push_n !== 0) c.solo_push0 = 0;
        porUuid.set(r.event_uuid, c);
      }
      return [...porUuid.values()];
    },
    getScheduledCallsInWindow: () => [],
    getPush1PrefiredKeys: () => new Set(marcadas),
    markPush1Prefired: (keys) => keys.forEach((k) => marcadas.add(k)),
  });
  return { llamadas, marcadas };
}

const push0 = (h) => h.store._rows.filter((r) => r.push_n === 0);

test('reunión del assigner para dentro de 3 días → Push 1 en el acto, y la víspera la salta', async () => {
  const h = installHarness(scheduler, { optins: [SALAZAR_PHONE], nowMs: NOW, accounts: ESTADOX });
  const { marcadas } = conHubspot(h, { creadas: [meeting({})] });

  await scheduler.runCalendlyPoll();
  assert.deepEqual(push0(h).map((r) => r.event_uuid), ['hubspot:m1']);
  assert.equal(h.store._rows.filter((r) => r.push_n === 3).length, 0, 'el Push 3 llega cuando entre a las 48h');

  await scheduler.runCalendlyDelivery();
  assert.equal(h.wa.sent.length, 1);
  assert.match(h.wa.sent[0].text, /Nueva call EL SÁBADO 17/);
  assert.match(h.wa.sent[0].text, /Henry Contreras/);
  assert.ok(marcadas.has('hubspot:m1'), 'marcada para el digest');

  // Viernes 16, 7pm Bogotá: el digest de la víspera ve la reunión y no la repite.
  h.clock.ms = Date.parse('2026-10-17T00:00:00Z');
  conHubspot(h, { enVentana: [meeting({})], marcadas });
  await scheduler.runPush1Early();
  await scheduler.runPush1();
  assert.equal(h.wa.sent.length, 1, 'ningún digest repitió el Push 1');
});

test('digest de la víspera: las reuniones de HubSpot ya avisadas cuentan en el encabezado', async () => {
  const h = installHarness(scheduler, { optins: [SALAZAR_PHONE], nowMs: Date.parse('2026-10-17T00:00:00Z'), accounts: ESTADOX });
  const TARDE = '2026-10-17T20:00:00Z';
  conHubspot(h, {
    enVentana: [meeting({ id: 'm1' }), meeting({ id: 'm2', startIso: TARDE })],
    marcadas: new Set(['hubspot:m1']),
  });
  await scheduler.runPush1Early();
  await scheduler.runPush1();
  assert.equal(h.wa.sent.length, 1);
  const texto = h.wa.sent[0].text;
  assert.match(texto, /tienes 2 llamadas mañana/, 'cuenta la ya avisada');
  assert.match(texto, /1 ya tenía su link/);
  assert.equal((texto.match(/https:\/\/wa\.me\//g) || []).length, 1, 'pero solo lista la que falta');
});

test('creada hace 2 horas → nada (no es una reserva nueva)', async () => {
  const h = installHarness(scheduler, { optins: [SALAZAR_PHONE], nowMs: NOW, accounts: ESTADOX });
  conHubspot(h, { creadas: [meeting({ createdMin: -120 })] });
  await scheduler.runCalendlyPoll();
  assert.equal(push0(h).length, 0);
});

test('a menos de 48h el barrido no la toca: un solo Push 0, el del poll', async () => {
  const h = installHarness(scheduler, { optins: [SALAZAR_PHONE], nowMs: NOW, accounts: ESTADOX });
  const cerca = meeting({ startIso: '2026-10-15T15:00:00Z' });
  conHubspot(h, { creadas: [cerca], enVentana: [cerca] });
  await scheduler.runCalendlyPoll();
  assert.equal(push0(h).length, 1);
  assert.ok(h.store._rows.some((r) => r.push_n === 3), 'esa sí la agenda el poll');
});

test('dos registros del mismo minuto (app + calendario) → un solo Push 0', async () => {
  const h = installHarness(scheduler, { optins: [SALAZAR_PHONE], nowMs: NOW, accounts: ESTADOX });
  conHubspot(h, { creadas: [meeting({ id: 'm1' }), meeting({ id: 'm2' })] });
  await scheduler.runCalendlyPoll();
  assert.equal(push0(h).length, 1);
});

test('la misma cita ya avisada por Calendly → no se avisa otra vez', async () => {
  const h = installHarness(scheduler, { optins: [SALAZAR_PHONE], nowMs: NOW, accounts: ESTADOX });
  h.store.scheduleCalendlyPush({
    event_uuid: 'cal-1',
    push_n: 0,
    program: 'second_brain',
    closer_email: SALAZAR,
    closer_phone: SALAZAR_PHONE,
    call_start: dbUtc(SABADO),
    due_at: dbUtc(new Date(NOW).toISOString()),
    message: 'Push 0 de Calendly',
  });
  conHubspot(h, { creadas: [meeting({})] });
  await scheduler.runCalendlyPoll();
  assert.deepEqual(push0(h).map((r) => r.event_uuid), ['cal-1']);
});

test('reagenda dentro del CRM a una fecha lejana → no es reserva nueva', async () => {
  const h = installHarness(scheduler, { optins: [SALAZAR_PHONE], nowMs: NOW, accounts: ESTADOX });
  // La original, creada hace 3 días para el jueves 16; la nueva, recién creada para el sábado.
  const vieja = meeting({ id: 'm0', startIso: '2026-10-16T15:00:00Z', createdMin: -3 * 1440 });
  const nueva = meeting({ id: 'm1' });
  conHubspot(h, { creadas: [nueva], contactos: { m1: 'c1' }, deContacto: { c1: ['m0', 'm1'] }, todas: [vieja] });
  await scheduler.runCalendlyPoll();
  assert.equal(push0(h).length, 0);
});

test('cita con solo su Push 0: al entrar a las 48h el poll le crea el Push 3', async () => {
  const h = installHarness(scheduler, { optins: [SALAZAR_PHONE], nowMs: NOW, accounts: ESTADOX });
  conHubspot(h, { creadas: [meeting({})] });
  await scheduler.runCalendlyPoll();
  assert.equal(push0(h).length, 1);

  h.clock.ms = Date.parse('2026-10-16T15:00:00Z'); // viernes, 24h antes
  conHubspot(h, { enVentana: [meeting({})] });
  await scheduler.runCalendlyPoll();
  assert.ok(h.store._rows.some((r) => r.event_uuid === 'hubspot:m1' && r.push_n === 3), 'Push 3 creado');
  assert.equal(push0(h).length, 1, 'y el Push 0 no se repite');
});

test('con la fuente única prendida también funciona', async () => {
  process.env.HUBSPOT_FUENTE_CONEXIONES = 'estadox';
  delete process.env.HUBSPOT_AGENDA_POLL;
  const h = installHarness(scheduler, { optins: [SALAZAR_PHONE], nowMs: NOW, accounts: ESTADOX });
  conHubspot(h, { creadas: [meeting({})] });
  await scheduler.runCalendlyPoll();
  assert.deepEqual(push0(h).map((r) => r.event_uuid), ['hubspot:m1']);
});

test('prueba vencida, o sin poll de HubSpot → ni una request', async () => {
  for (const env of [{ CALENDLY_PUSH1_AL_AGENDAR_HASTA: '2026-10-13' }, { HUBSPOT_AGENDA_POLL: 'false' }]) {
    Object.assign(process.env, env);
    const h = installHarness(scheduler, { optins: [SALAZAR_PHONE], nowMs: NOW, accounts: ESTADOX });
    const { llamadas } = conHubspot(h, { creadas: [meeting({})] });
    await scheduler.runCalendlyPoll();
    assert.equal(push0(h).length, 0, JSON.stringify(env));
    assert.equal(llamadas.creadas, 0, `ninguna búsqueda en HubSpot con ${JSON.stringify(env)}`);
    process.env.CALENDLY_PUSH1_AL_AGENDAR_HASTA = '2026-10-23';
    process.env.HUBSPOT_AGENDA_POLL = 'true';
  }
});
