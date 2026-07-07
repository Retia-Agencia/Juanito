// test/hubspot.test.js
// Tests del módulo HubSpot (fuente alterna del motor precall): el lector REST
// (searchDeals con un fetch falso, sin red) y el adaptador deal→evento. No toca DB →
// corre en Windows sin better-sqlite3:  node --test test/hubspot.test.js
//   (o con better-sqlite3 sin compilar: npm install --ignore-scripts && npm test)

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';

import { searchDeals, DEAL_PROPERTIES, hasHubspotCreds } from '../src/hubspot/client.js';
import { dealToEvent, listProgramEvents, getFirstInvitee, getEvent, eventUri, pipelineConfig } from '../src/hubspot/index.js';
import { closerEmailOf, programKeyOf, prospectPhoneOf } from '../src/calendly/index.js';
import { runCalendlyPoll, runCalendlyDelivery } from '../src/scheduler/calendly.js';
import { makeStore, makeWaSpy } from './helpers/calendly-harness.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deal(id, props) {
  return { id, properties: props };
}

// fetch falso: registra las llamadas y devuelve la cola de respuestas (para paginación).
function fakeFetch(recorder, responses) {
  let i = 0;
  return async (url, opts) => {
    recorder.push({ url, opts, body: opts?.body ? JSON.parse(opts.body) : null });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      headers: { get: () => r.retryAfter || null },
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})),
    };
  };
}

// Corre `fn` con globalThis.fetch mockeado y lo restaura al terminar (no contamina otros archivos).
async function withFakeFetch(recorder, responses, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = fakeFetch(recorder, responses);
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

const SB = { pipeline: '904247681', stage: '1368121620' };
const LI = { pipeline: '906259304', stage: '1372359685' };

// ─── hasHubspotCreds ────────────────────────────────────────────────────────

test('hasHubspotCreds: true solo con token no vacío', () => {
  assert.equal(hasHubspotCreds({ HUBSPOT_TOKEN: 'pat-x' }), true);
  assert.equal(hasHubspotCreds({ HUBSPOT_TOKEN: '   ' }), false);
  assert.equal(hasHubspotCreds({}), false);
});

// ─── dealToEvent (puro) ───────────────────────────────────────────────────────

test('dealToEvent mapea deal→evento estilo Calendly (closer, hora, programa, invitee)', () => {
  const ev = dealToEvent(
    deal('42', {
      calendly_host_email: 'PABLO.LOZANO@30x.com',
      calendly_meeting_start_time: '2026-07-08T20:00:00Z',
      telefono_de_contcato: '+57 310 306 2287',
      dealname: 'Juan Perez',
      pipeline: '904247681',
      dealstage: '1368121620',
    })
  );
  assert.equal(ev.uri, 'hubspot:deal:42');
  assert.equal(ev.start_time, '2026-07-08T20:00:00Z');
  assert.equal(ev.status, 'active');
  // El closer sale de calendly_host_email (no del owner), normalizado a minúsculas.
  assert.equal(closerEmailOf(ev), 'pablo.lozano@30x.com');
  // El pipeline se resuelve a la clave de programa que programKeyOf ya acepta.
  assert.equal(ev.event_type, 'second_brain');
  assert.equal(programKeyOf(ev.event_type), 'second_brain');
  // El invitee viene precalculado del propio deal (sin segundo fetch); teléfono a dígitos.
  assert.equal(ev._invitee.name, 'Juan Perez');
  assert.equal(prospectPhoneOf(ev._invitee), '573103062287');
});

test('dealToEvent: pipeline LinkedIn → programa linkedin', () => {
  const ev = dealToEvent(deal('7', { pipeline: '906259304', calendly_host_email: 'x@30x.com', calendly_meeting_start_time: 'z' }));
  assert.equal(ev.event_type, 'linkedin');
  assert.equal(programKeyOf(ev.event_type), 'linkedin');
});

test('pipelineConfig respeta overrides por env', () => {
  const cfg = pipelineConfig({ HUBSPOT_PIPELINE_SECONDBRAIN: '999', HUBSPOT_STAGE_SECONDBRAIN: '888' });
  assert.equal(cfg[0].pipeline, '999');
  assert.equal(cfg[0].stage, '888');
  assert.equal(cfg[0].program, 'second_brain');
  // Lo no-overrideado cae al default.
  assert.equal(cfg[1].pipeline, '906259304');
});

// ─── searchDeals (fetch falso) ────────────────────────────────────────────────

test('searchDeals: POST con filterGroups (OR por pipeline), properties y paginación', async () => {
  const calls = [];
  const deals = await withFakeFetch(
    calls,
    [
      { body: { results: [deal('1', {})], paging: { next: { after: '100' } } } },
      { body: { results: [deal('2', {})] } },
    ],
    () => searchDeals({ minStartIso: '2026-07-08T05:00:00Z', maxStartIso: '2026-07-09T04:59:59Z', pipelines: [SB, LI], token: 'tok' })
  );

  assert.equal(deals.length, 2);
  assert.equal(calls.length, 2); // dos páginas
  // Endpoint + auth + método.
  assert.match(calls[0].url, /\/crm\/v3\/objects\/deals\/search$/);
  assert.equal(calls[0].opts.method, 'POST');
  assert.match(calls[0].opts.headers.Authorization, /^Bearer tok$/);
  // Un filterGroup por pipeline (OR); cada uno con pipeline+dealstage+rango de fecha.
  const fg = calls[0].body.filterGroups;
  assert.equal(fg.length, 2);
  assert.deepEqual(
    fg[0].filters.map((f) => [f.propertyName, f.operator, f.value]),
    [
      ['pipeline', 'EQ', '904247681'],
      ['dealstage', 'EQ', '1368121620'],
      ['calendly_meeting_start_time', 'GTE', '2026-07-08T05:00:00Z'],
      ['calendly_meeting_start_time', 'LTE', '2026-07-09T04:59:59Z'],
    ]
  );
  // Pide todas las propiedades (incluida `pipeline`, para mapear el programa).
  assert.deepEqual(calls[0].body.properties, DEAL_PROPERTIES);
  assert.ok(DEAL_PROPERTIES.includes('telefono_de_contcato')); // typo intencional preservado
  // La segunda página manda el cursor `after`.
  assert.equal(calls[1].body.after, '100');
});

test('searchDeals: 401 lanza con el status (lo detecta isAuthError del motor)', async () => {
  await assert.rejects(
    () => withFakeFetch([], [{ ok: false, status: 401, body: 'unauthorized' }], () =>
      searchDeals({ minStartIso: 'a', maxStartIso: 'b', pipelines: [SB], token: 'bad' })
    ),
    /HubSpot 401/
  );
});

test('searchDeals: sin token lanza', async () => {
  await assert.rejects(() => searchDeals({ minStartIso: 'a', maxStartIso: 'b', pipelines: [SB], token: '' }), /HUBSPOT_TOKEN/);
});

// ─── listProgramEvents + getFirstInvitee (round-trip con fetch falso) ──────────

test('listProgramEvents mapea y descarta deals sin closer o sin hora; getFirstInvitee sirve el invitee', async () => {
  process.env.HUBSPOT_TOKEN = 'tok';
  const calls = [];
  const events = await withFakeFetch(
    calls,
    [
      {
        body: {
          results: [
            deal('10', {
              calendly_host_email: 'pablo.lozano@30x.com',
              calendly_meeting_start_time: '2026-07-08T20:00:00Z',
              telefono_de_contcato: '573103062287',
              dealname: 'Ana Ruiz',
              pipeline: '904247681',
            }),
            deal('11', { calendly_meeting_start_time: '2026-07-08T21:00:00Z', pipeline: '906259304' }), // sin closer → descartado
            deal('12', { calendly_host_email: 'maca.celis@30x.com', pipeline: '906259304' }), // sin hora → descartado
          ],
        },
      },
    ],
    () => listProgramEvents({ minStartIso: 'a', maxStartIso: 'b' })
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].uri, 'hubspot:deal:10');
  const inv = await getFirstInvitee('hubspot:deal:10');
  assert.equal(inv.name, 'Ana Ruiz');
  assert.equal(inv.text_reminder_number, '573103062287');
  // uri desconocido → null (contrato igual al de Calendly).
  assert.equal(await getFirstInvitee('hubspot:deal:999'), null);

  delete process.env.HUBSPOT_TOKEN;
});

// ─── getEvent / eventUri (re-validación en la entrega) ─────────────────────────

test('eventUri devuelve el uuid tal cual (getEvent lo parsea)', () => {
  assert.equal(eventUri('hubspot:deal:42'), 'hubspot:deal:42');
});

test('getEvent: deal en etapa Agendado → active, con start_time y programa', async () => {
  process.env.HUBSPOT_TOKEN = 'tok';
  const ev = await withFakeFetch([], [
    { body: { id: '42', properties: { calendly_meeting_start_time: '2026-07-08T20:00:00Z', dealstage: '1368121620', pipeline: '904247681' } } },
  ], () => getEvent('hubspot:deal:42'));
  assert.equal(ev.status, 'active');
  assert.equal(ev.start_time, '2026-07-08T20:00:00Z');
  assert.equal(ev.event_type, 'second_brain');
  assert.equal(ev.location, null); // sin HUBSPOT_JOINURL_PROP → sin link
  delete process.env.HUBSPOT_TOKEN;
});

test('getEvent: deal fuera de la etapa Agendado → canceled (conservador)', async () => {
  process.env.HUBSPOT_TOKEN = 'tok';
  const ev = await withFakeFetch([], [
    { body: { id: '42', properties: { calendly_meeting_start_time: 'x', dealstage: 'OTRA_ETAPA', pipeline: '904247681' } } },
  ], () => getEvent('hubspot:deal:42'));
  assert.equal(ev.status, 'canceled');
  delete process.env.HUBSPOT_TOKEN;
});

test('getEvent: join URL desde HUBSPOT_JOINURL_PROP (pide la propiedad extra en el GET)', async () => {
  process.env.HUBSPOT_TOKEN = 'tok';
  process.env.HUBSPOT_JOINURL_PROP = 'zoom_link';
  const calls = [];
  const ev = await withFakeFetch(calls, [
    { body: { id: '9', properties: { calendly_meeting_start_time: 'x', dealstage: '1372359685', pipeline: '906259304', zoom_link: 'https://zoom.us/j/9' } } },
  ], () => getEvent('hubspot:deal:9'));
  assert.deepEqual(ev.location, { join_url: 'https://zoom.us/j/9' });
  assert.match(calls[0].url, /zoom_link/); // la propiedad configurada se pidió en el GET
  delete process.env.HUBSPOT_JOINURL_PROP;
  delete process.env.HUBSPOT_TOKEN;
});

// ─── Integración: el motor (poll+delivery) corre con una source de HubSpot ─────
// Prueba que runCalendlyPoll/runCalendlyDelivery funcionan inyectándoles una source
// estilo HubSpot (uris 'hubspot:deal:X', eventUri propio), agendando y entregando el Push 3
// contra el store en memoria del harness. Reemplaza deps() sin __setDeps (se pasa por arg).

function makeHubspotSource({ events, store, wa, clock, dryRunOverride = false }) {
  const byUri = new Map(events.map((e) => [e.uri, e]));
  return {
    now: () => clock.ms,
    async listProgramEvents({ minStartIso, maxStartIso }) {
      const min = new Date(minStartIso).getTime();
      const max = new Date(maxStartIso).getTime();
      return [...byUri.values()]
        .filter((e) => e.status === 'active')
        .filter((e) => {
          const t = new Date(e.start_time).getTime();
          return t >= min && t < max;
        });
    },
    async getFirstInvitee(uri) {
      return byUri.get(uri)?.__invitee || null;
    },
    async getEvent(uri) {
      const e = byUri.get(uri);
      return e
        ? { status: e.status, start_time: e.start_time, event_type: e.event_type, location: null }
        : { status: 'canceled', start_time: null, event_type: null, location: null };
    },
    eventUri: (uuid) => uuid, // uuid ya es 'hubspot:deal:X'
    scheduleCalendlyPush: store.scheduleCalendlyPush,
    getDueCalendlyPushes: store.getDueCalendlyPushes,
    claimCalendlyPush: store.claimCalendlyPush,
    revertCalendlyPush: store.revertCalendlyPush,
    markCalendlyPushSent: store.markCalendlyPushSent,
    markCalendlyPushSkipped: store.markCalendlyPushSkipped,
    isOptedIn: store.isOptedIn,
    getOptin: store.getOptin,
    isCalendlyPaused: store.isCalendlyPaused,
    sendMessage: wa.sendMessage,
    push4Enabled: false,
    dryRunOverride,
    logLabel: 'HubSpot',
  };
}

test('integración: poll+delivery con source HubSpot agenda Push 3 (start-25) y lo entrega', async () => {
  process.env.CALENDLY_DRY_RUN = 'false';
  process.env.CALENDLY_REQUIRE_OPTIN = 'true';
  process.env.CALENDLY_PUSH3_LEAD_MIN = '25';
  const now = Date.now();
  const startIso = new Date(now + 20 * 60000).toISOString(); // en 20 min → catch-up inmediato
  const ev = {
    uri: 'hubspot:deal:501',
    start_time: startIso,
    status: 'active',
    event_type: 'second_brain',
    event_memberships: [{ user_email: 'sebastian.salazar@30x.com' }],
    __invitee: { name: 'Ana Ruiz', text_reminder_number: '573001112222' },
  };
  const clock = { ms: now };
  const store = makeStore({ optins: ['+573054312905'], nowRef: clock }); // opt-in del closer Salazar
  const wa = makeWaSpy();
  const source = makeHubspotSource({ events: [ev], store, wa, clock });

  await runCalendlyPoll(source);
  assert.equal(store._rows.length, 1, 'el poll debió agendar 1 push');
  assert.equal(store._rows[0].push_n, 3);
  assert.equal(store._rows[0].event_uuid, 'hubspot:deal:501');

  await runCalendlyDelivery(source);
  assert.equal(wa.sent.length, 1, 'el Push 3 debió entregarse al hilo del closer');
  assert.match(wa.sent[0].text, /Push 3/);
  assert.equal(store._rows[0].status, 'sent');
});

test('integración: cancelación en HubSpot (deal salió de Agendado) → no se entrega', async () => {
  process.env.CALENDLY_DRY_RUN = 'false';
  process.env.CALENDLY_REQUIRE_OPTIN = 'true';
  process.env.CALENDLY_PUSH3_LEAD_MIN = '25';
  const now = Date.now();
  const startIso = new Date(now + 20 * 60000).toISOString();
  const ev = {
    uri: 'hubspot:deal:777',
    start_time: startIso,
    status: 'active',
    event_type: 'second_brain',
    event_memberships: [{ user_email: 'sebastian.salazar@30x.com' }],
    __invitee: { name: 'Ana Ruiz', text_reminder_number: '573001112222' },
  };
  const clock = { ms: now };
  const store = makeStore({ optins: ['+573054312905'], nowRef: clock });
  const wa = makeWaSpy();
  const source = makeHubspotSource({ events: [ev], store, wa, clock });

  await runCalendlyPoll(source);
  assert.equal(store._rows.length, 1);

  // La cita se cancela (el deal sale de Agendado) antes de entregar.
  ev.status = 'canceled';
  await runCalendlyDelivery(source);
  assert.equal(wa.sent.length, 0, 'no se entrega una cita cancelada');
  assert.equal(store._rows[0].status, 'skipped');
});
