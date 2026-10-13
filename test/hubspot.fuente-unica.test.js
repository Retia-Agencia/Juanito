// test/hubspot.fuente-unica.test.js
// §18.CO — HubSpot como fuente única de las citas (30X cambió Calendly por el assigner).
//
// Tier 1: puro + harness (sin DB nativa, sin red, sin WhatsApp real). Lo que se fija:
//   1. títulos del assigner ("second-brain", "Nombre | Programa") y programa por deal;
//   2. el link de la llamada sale de hs_video_conference_url;
//   3. con la bandera, Calendly no se lee y el poll de HubSpot corre (filtrado por owners);
//   4. al entregar, un push hubspot:<id> se valida contra HubSpot: borrada sin gemela / cancelada
//      / movida → no sale; HubSpot caído → sale igual (perder el aviso de una call real es peor);
//   5. sin la bandera, nada cambia.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';

import * as scheduler from '../src/scheduler/calendly.js';
import { __resetHealth } from '../src/calendly/health.js';
import { programFromTitle } from '../src/calendly/programs.js';
import { meetingsToCalls, esReunionCancelada } from '../src/hubspot/meetings.js';
import { programForPipeline } from '../src/hubspot/deals.js';
import { installHarness, makeEvent } from './helpers/calendly-harness.js';

// Closer de fixture del harness (conexión 'estadox', ver calendly.digest-hubspot.test.js).
const SALAZAR = 'sebastian.salazar@30x.com';
const SALAZAR_PHONE = '+573054312905';
const OWNER_ID = '77001';
const TITULO = 'Entrevista de Postulación Programa AI Second Brain';

const isoEn = (min, base) => new Date(base + min * 60000).toISOString();
const dbUtc = (iso) => iso.slice(0, 19).replace('T', ' ');
const meeting = ({ id = 'm1', startIso, title = TITULO, ownerId = OWNER_ID, outcome = null, video = null }) => ({
  id,
  properties: {
    hubspot_owner_id: ownerId,
    hs_meeting_title: title,
    hs_meeting_start_time: String(Date.parse(startIso)),
    hs_meeting_outcome: outcome,
    hs_video_conference_url: video,
    hs_createdate: new Date(Date.parse(startIso) - 2 * 86400000).toISOString(),
  },
});

beforeEach(() => {
  process.env.CALENDLY_DRY_RUN = 'false';
  process.env.CALENDLY_DRY_RUN_ESTADOX = 'false';
  process.env.CALENDLY_REQUIRE_OPTIN = 'true';
  process.env.CALENDLY_PUSH4_ENABLED = 'false';
  process.env.ADMIN_LID = '129446371655733@lid';
  delete process.env.HUBSPOT_AGENDA_POLL;
  __resetHealth();
  scheduler.__resetDeps();
});
afterEach(() => {
  delete process.env.HUBSPOT_FUENTE_CONEXIONES;
});

// ─── 1-2. Puras ───────────────────────────────────────────────────────────────

test('títulos del assigner: guiones y barras', () => {
  assert.equal(programFromTitle('Agendamiento — second-brain — Pablo Lozano'), 'second_brain');
  assert.equal(programFromTitle('Agendamiento — operaciones-con-ai — Lucas Mendoza'), 'operaciones');
  assert.equal(programFromTitle('Ana Pérez | Instagram & TikTok for Business'), 'instagram');
  assert.equal(programFromTitle('Agendamiento — ai-for-developers — Pablo Suarez'), 'developers');
  assert.equal(programFromTitle('Daily Comercial'), null);
});

test('programa por deal cuando el título no lo dice; el título manda', () => {
  const ms = [meeting({ id: 'a', startIso: '2026-10-14T15:00:00Z', title: 'Admisiones' }),
    meeting({ id: 'b', startIso: '2026-10-14T16:00:00Z' })];
  const calls = meetingsToCalls(ms, {
    ownerEmailById: { [OWNER_ID]: SALAZAR },
    ownerToCloser: { [SALAZAR]: SALAZAR },
    programaPorMeeting: { a: 'operaciones', b: 'operaciones' },
  });
  assert.deepEqual(calls.map((c) => [c.meeting_id, c.program]), [['a', 'operaciones'], ['b', 'second_brain']]);
  assert.equal(programForPipeline('916500025'), 'instagram');
  assert.equal(programForPipeline('887379064'), 'developers');
  assert.equal(programForPipeline('123'), null);
});

test('el link de la llamada sale de hs_video_conference_url', () => {
  const [c] = meetingsToCalls([meeting({ startIso: '2026-10-14T15:00:00Z', video: 'https://meet.google.com/abc-defg-hij' })], {
    ownerEmailById: { [OWNER_ID]: SALAZAR },
    ownerToCloser: { [SALAZAR]: SALAZAR },
  });
  assert.equal(c.join_url, 'https://meet.google.com/abc-defg-hij');
});

test('reunión cancelada: título o outcome', () => {
  assert.equal(esReunionCancelada(meeting({ startIso: '2026-10-14T15:00:00Z', title: 'Canceled: Entrevista…' })), true);
  assert.equal(esReunionCancelada(meeting({ startIso: '2026-10-14T15:00:00Z', title: 'Cancelado: Entrevista…' })), true);
  assert.equal(esReunionCancelada(meeting({ startIso: '2026-10-14T15:00:00Z', outcome: 'CANCELED' })), true);
  assert.equal(esReunionCancelada(meeting({ startIso: '2026-10-14T15:00:00Z' })), false);
});

// ─── 3. Fuente: Calendly no se lee, el poll de HubSpot corre ──────────────────

function conHubspot(h, { meetings = [], strict = {} } = {}) {
  const llamadas = { search: [], strict: [], gemelas: 0 };
  scheduler.__setDeps({
    ...h.deps,
    hubspotEnabled: () => true,
    async getOwnerEmailMap() {
      return { [OWNER_ID]: SALAZAR, '99': 'otra.persona@30x.com' };
    },
    async searchMeetingsInWindow(args) {
      llamadas.search.push(args);
      return meetings;
    },
    async getMeetingContact() {
      return { name: 'Beto Ruiz', phone: '+573001112222' };
    },
    getScheduledCallsInWindow: () => h.store._rows.map((r) => ({ closer_email: r.closer_email, call_start: r.call_start })),
    async getMeetingStrict(id) {
      llamadas.strict.push(id);
      if (strict.falla) throw new Error('HubSpot 502: caído');
      return strict.reunion ? { found: true, meeting: strict.reunion } : { found: false };
    },
    async searchMeetingsStrict() {
      llamadas.gemelas++;
      return strict.gemelas || [];
    },
  });
  return llamadas;
}

test('con la bandera: el poll de Calendly no lee esa conexión y el de HubSpot corre solo', async () => {
  // El harness lista Calendly desde la cuenta '30x' y el closer de fixture es de 'estadox'.
  process.env.HUBSPOT_FUENTE_CONEXIONES = '30x,estadox';
  const nowMs = Date.parse('2026-10-14T13:00:00Z'); // 8am Bogotá
  const events = [makeEvent({ uuid: 'cal-1', startIso: isoEn(240, nowMs), closerEmail: SALAZAR })];
  const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs });
  const llamadas = conHubspot(h, { meetings: [meeting({ id: 'm1', startIso: isoEn(300, nowMs) })] });

  await scheduler.runCalendlyPoll();
  assert.equal(h.store._rows.filter((r) => r.event_uuid === 'cal-1').length, 0, 'Calendly no agenda nada');

  await scheduler.runHubspotAgendaPoll(); // HUBSPOT_AGENDA_POLL apagado: corre por la fuente única
  const rows = h.store._rows.filter((r) => r.event_uuid === 'hubspot:m1');
  assert.ok(rows.some((r) => r.push_n === 3), 'Push 3 de la cita de HubSpot');
  assert.deepEqual(llamadas.search.at(-1).ownerIds, [OWNER_ID], 'búsqueda filtrada por los owners que son closers');
});

test('sin la bandera: el poll de HubSpot sigue apagado y Calendly sí se lee', async () => {
  const nowMs = Date.parse('2026-10-14T13:00:00Z');
  const events = [makeEvent({ uuid: 'cal-1', startIso: isoEn(240, nowMs), closerEmail: SALAZAR })];
  const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs });
  conHubspot(h, { meetings: [meeting({ id: 'm1', startIso: isoEn(300, nowMs) })] });
  await scheduler.runCalendlyPoll();
  assert.ok(h.store._rows.some((r) => r.event_uuid === 'cal-1'));
  assert.equal(await scheduler.runHubspotAgendaPoll(), 0);
});

// ─── 4. Entrega validada contra HubSpot ───────────────────────────────────────

function pushHubspot(h, { nowMs, startIso, push_n = 3 }) {
  h.store.scheduleCalendlyPush({
    event_uuid: 'hubspot:m1',
    push_n,
    program: 'second_brain',
    closer_email: SALAZAR,
    closer_phone: SALAZAR_PHONE,
    prospect_name: 'Beto Ruiz',
    prospect_phone: '+573001112222',
    call_start: dbUtc(startIso),
    due_at: dbUtc(new Date(nowMs - 60000).toISOString()),
    message: 'Push 3 guardado',
  });
}

const escenario = async ({ strict, push_n = 3, bandera = true }) => {
  if (bandera) process.env.HUBSPOT_FUENTE_CONEXIONES = 'estadox';
  const nowMs = Date.parse('2026-10-14T14:35:00Z');
  const startIso = push_n === 4 ? isoEn(-40, nowMs) : isoEn(25, nowMs);
  const h = installHarness(scheduler, { events: [], optins: [SALAZAR_PHONE], nowMs });
  const llamadas = conHubspot(h, { strict: typeof strict === 'function' ? strict(startIso) : strict });
  pushHubspot(h, { nowMs, startIso, push_n });
  await scheduler.runCalendlyDelivery();
  return { h, llamadas, row: h.store._rows[0] };
};

test('entrega: la reunión sigue igual → sale', async () => {
  const { h, row } = await escenario({ strict: (startIso) => ({ reunion: meeting({ id: 'm1', startIso }) }) });
  assert.equal(h.wa.sent.length, 1);
  assert.equal(row.status, 'sent');
});

test('entrega: cancelada en HubSpot → no sale', async () => {
  const { h, row } = await escenario({ strict: (startIso) => ({ reunion: meeting({ id: 'm1', startIso, title: 'Canceled: Entrevista' }) }) });
  assert.equal(h.wa.sent.length, 0);
  assert.equal(row.status, 'skipped');
});

test('entrega: cambió de hora en HubSpot → no sale (el poll agenda la nueva)', async () => {
  const { h, row } = await escenario({ strict: (startIso) => ({ reunion: meeting({ id: 'm1', startIso: isoEn(90, Date.parse(startIso)) }) }) });
  assert.equal(h.wa.sent.length, 0);
  assert.equal(row.status, 'skipped');
});

test('entrega: borrada y sin gemela → no sale; borrada con gemela viva → sale', async () => {
  const sola = await escenario({ strict: { gemelas: [] } });
  assert.equal(sola.h.wa.sent.length, 0);
  const conGemela = await escenario({ strict: (startIso) => ({ gemelas: [meeting({ id: 'm2', startIso })] }) });
  assert.equal(conGemela.h.wa.sent.length, 1, 'la otra copia (calendario) sigue viva');
});

test('entrega: HubSpot caído → sale con lo guardado', async () => {
  const { h, row } = await escenario({ strict: { falla: true } });
  assert.equal(h.wa.sent.length, 1);
  assert.equal(h.wa.sent[0].text, 'Push 3 guardado');
  assert.equal(row.status, 'sent');
});

test('Push 4 de una cita borrada → outcome automático "cancelado", sin preguntar', async () => {
  process.env.CALENDLY_PUSH4_ENABLED = 'true';
  const { h } = await escenario({ strict: { gemelas: [] }, push_n: 4 });
  assert.equal(h.wa.sent.length, 0);
  assert.equal(h.store._outcomes.at(-1)?.asistencia, 'cancelado');
});

test('sin la bandera: la entrega no consulta HubSpot', async () => {
  const { h, llamadas } = await escenario({ strict: { gemelas: [] }, bandera: false });
  assert.equal(llamadas.strict.length, 0);
  assert.equal(h.wa.sent.length, 1);
});
