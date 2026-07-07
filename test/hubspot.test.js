// test/hubspot.test.js
// Tests del módulo HubSpot (fuente alterna del motor precall): el lector REST
// (searchDeals con un fetch falso, sin red) y el adaptador deal→evento. No toca DB →
// corre en Windows sin better-sqlite3:  node --test test/hubspot.test.js
//   (o con better-sqlite3 sin compilar: npm install --ignore-scripts && npm test)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { searchDeals, DEAL_PROPERTIES, hasHubspotCreds } from '../src/hubspot/client.js';
import { dealToEvent, listProgramEvents, getFirstInvitee, pipelineConfig } from '../src/hubspot/index.js';
import { closerEmailOf, programKeyOf, prospectPhoneOf } from '../src/calendly/index.js';

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
