// test/calendly.playbook.test.js
// §18.CU — Playbook de confirmación de agendas de 30X aplicado a los pushes precall.
//
// Tier 1: puro + harness (sin DB nativa, sin red, sin WhatsApp real). Lo que se fija:
//   · el copy de cada toque (bienvenida, 48 h, refuerzo, liberar, 1 h antes, no se conecta);
//   · con la bandera, la víspera pregunta quién confirmó en vez de mandar links, y el Push 1 y el
//     Push 2 de siempre no salen para esa conexión; sin la bandera, todo como antes;
//   · el toque 2 lista las de pasado mañana y se salta las reservadas hace un rato;
//   · el Push 3 sale 1 h antes, nace el Push 7 a los +10 min, y el corte los frena.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';

import * as scheduler from '../src/scheduler/calendly.js';
import { __resetHealth } from '../src/calendly/health.js';
import { buildPrecallText, buildPush0Message, buildPush7Message } from '../src/calendly/index.js';
import { buildConfirmacionPregunta, buildCorteAcciones, buildCorteRecordatorio } from '../src/calendly/confirmacion-logic.js';
import { installHarness, makeEvent } from './helpers/calendly-harness.js';

// Closer de fixture de la conexión '30x', igual que el event type por default del harness (AI
// Second Brain): copy y scheduler miran la misma conexión, como en producción.
const LUCAS = 'lucas.mendoza@30x.com';
const LUCAS_PHONE = '+573014477044';
const PLAYBOOK = '30x';
// Ojo con la hora: al lead le llega "3:00 pm" (formatLeadTime) y al closer "03:00 p. m." con
// espacios no separables (formatCallTime); por eso las regex de abajo usan \s en el segundo caso.

// 2026-06-15 08:00 Bogotá = 13:00 UTC.
const NOW = Date.parse('2026-06-15T13:00:00.000Z');
const MANANA_3PM = '2026-06-16T20:00:00.000Z';
const MANANA_10AM = '2026-06-16T15:00:00.000Z';
const PASADO_3PM = '2026-06-17T20:00:00.000Z';

const texto = (link) => decodeURIComponent(link.split('?text=')[1]);
const links = (msg) => msg.match(/https:\/\/wa\.me\/\S+/g) || [];

beforeEach(() => {
  process.env.CALENDLY_DRY_RUN = 'false';
  process.env.CALENDLY_DRY_RUN_ESTADOX = 'false';
  process.env.CALENDLY_REQUIRE_OPTIN = 'true';
  process.env.CALENDLY_PUSH4_ENABLED = 'false';
  process.env.CALENDLY_PUSH3_LEAD_MIN = '25';
  process.env.ADMIN_LID = '129446371655733@lid';
  delete process.env.CALENDLY_CONFIRMACION_PUSH2;
  delete process.env.HUBSPOT_FUENTE_CONEXIONES;
  __resetHealth();
  scheduler.__resetDeps();
});
afterEach(() => {
  delete process.env.CALENDLY_PLAYBOOK;
  delete process.env.CALENDLY_PLAYBOOK_RESCATE_DESDE;
  delete process.env.HUBSPOT_FUENTE_CONEXIONES;
});

// ─── Copy (puro) ──────────────────────────────────────────────────────────────

test('toque 1: la bienvenida pide confirmar, pregunta el país y lleva el material', () => {
  const t = buildPrecallText({
    programKey: 'second_brain',
    pushN: 'bienvenida',
    primerNombre: 'Ana',
    closer: 'Pablo',
    cuando: 'el miércoles 17 de junio a las 3:00 p. m.',
  });
  assert.match(t, /Ya quedó agendada tu llamada/);
  assert.match(t, /el miércoles 17 de junio a las 3:00 p\. m\., hora Colombia/);
  assert.match(t, /¿Me confirmas que vas a poder asistir\?/);
  assert.match(t, /desde qué país te conectas/);
  assert.match(t, /prender la cámara/);
  assert.match(t, /instalar la herramienta de inteligencia artificial Claude/);
});

test('toque 2: "respóndeme SÍ" y la pregunta de diagnóstico', () => {
  const t = buildPrecallText({ programKey: 'linkedin', pushN: 48, primerNombre: 'Ana', closer: 'Pablo', dia: 'del miércoles 17', hora: '3:00 p. m.' });
  assert.match(t, /tu llamada del miércoles 17 a las 3:00 p\. m\., hora Colombia/);
  assert.match(t, /Respóndeme \*SÍ\* para dejar tu espacio reservado/);
  assert.match(t, /¿qué quieres resolver con el programa\?/);
});

test('toque 4: con la bandera el Push 3 dice "te espero a las"; sin ella, el de siempre', () => {
  const args = { programKey: 'second_brain', pushN: 3, primerNombre: 'Ana', closer: 'Pablo', hora: '3:00 p. m.', linkLlamada: 'https://meet.google.com/abc' };
  assert.match(buildPrecallText(args), /^Ya casi nos vemos Ana/);
  process.env.CALENDLY_PLAYBOOK = '30x';
  const t = buildPrecallText(args);
  assert.match(t, /link de nuestra llamada:\nhttps:\/\/meet\.google\.com\/abc/);
  assert.match(t, /Te espero a las 3:00 p\. m\., hora Colombia$/);
  // Retia no está en la bandera: su Push 3 no cambia.
  assert.match(buildPrecallText({ ...args, programKey: 'tactical_investor' }), /^Ya casi nos vemos/);
});

test('Push 0 con la bandera: es el toque 1 y su link lleva la bienvenida', () => {
  const base = { name: 'Ana Gómez', firstName: 'Ana', phone: '+573001112222', startIso: PASADO_3PM, programKey: 'second_brain', closer: 'Pablo', when: 'otro', base: new Date(NOW) };
  assert.match(texto(links(buildPush0Message(base))[0]), /Quería personalmente recordarte/);
  process.env.CALENDLY_PLAYBOOK = '30x';
  const msg = buildPush0Message(base);
  assert.match(msg, /\*toque 1\* del playbook/);
  assert.match(msg, /enviarle su bienvenida/);
  const t = texto(links(msg)[0]);
  assert.match(t, /Ya quedó agendada tu llamada/);
  assert.match(t, /el miércoles 17 de junio a las 3:00 pm, hora Colombia/);
});

test('corte: la pregunta de la víspera habla de mañana', () => {
  const p = buildConfirmacionPregunta({ items: [{ name: 'Ana', startIso: MANANA_3PM }], tz: 'America/Bogota', corte: true });
  assert.match(p, /¿quiénes te confirmaron para mañana\?/);
  assert.match(p, /1\. 03:00\sp\.\sm\. — Ana/);
});

test('corte: refuerzo a las confirmadas, "voy a liberar" a las sin confirmar, HubSpot a las canceladas', () => {
  process.env.CALENDLY_PLAYBOOK = '30x';
  const filas = [
    { posicion: 1, lead_name: 'Ana Gómez', lead_phone: '+573001112222', program: 'second_brain', call_start: '2026-06-16 15:00:00', estado: 'pendiente' },
    { posicion: 2, lead_name: 'Beto Ruiz', lead_phone: '+573003334444', program: 'second_brain', call_start: '2026-06-16 20:00:00', estado: 'pendiente' },
    { posicion: 3, lead_name: 'Caro Díaz', lead_phone: null, program: 'second_brain', call_start: '2026-06-16 21:00:00', estado: 'pendiente' },
  ];
  const msg = buildCorteAcciones({
    filas,
    estados: { 1: 'confirmada', 2: 'no_confirmada', 3: 'cancelada' },
    closer: 'Pablo',
    tz: 'America/Bogota',
    base: new Date(NOW),
  });
  const [refuerzo, liberar] = links(msg);
  assert.match(texto(refuerzo), /^Perfecto Ana, gracias por confirmar! Te espero mañana a las 10:00 am, hora Colombia/);
  assert.match(texto(liberar), /tu llamada de mañana a las 3:00 pm, hora Colombia/);
  assert.match(texto(liberar), /Como no tuve tu confirmación, voy a liberar el espacio\. Escríbeme y la reprogramamos$/);
  assert.match(msg, /Estado de agenda = \*Cancelada\*/);
  assert.match(msg, /❌ \*Cancelaron\*[^]*3\. 04:00\sp\.\sm\. — Caro Díaz/);
  assert.equal(links(msg).length, 2, 'la cancelada no lleva link');

  // Corrección: solo la que cambió.
  const corr = buildCorteAcciones({ filas, estados: { 2: 'confirmada' }, closer: 'Pablo', tz: 'America/Bogota', base: new Date(NOW), soloPosiciones: [2] });
  assert.equal(links(corr).length, 1);
  assert.match(texto(links(corr)[0]), /^Perfecto Beto/);
});

test('Push 7: "¿se conectó?" con link al lead y el registro de No-show', () => {
  const msg = buildPush7Message({ name: 'Ana Gómez', firstName: 'Ana', phone: '+573001112222', startIso: MANANA_3PM, programKey: 'second_brain', closer: 'Pablo', linkLlamada: 'https://meet.google.com/abc' });
  assert.match(msg, /¿Ana Gómez se conectó\?/);
  assert.match(msg, /\*No-show\*/);
  const t = texto(links(msg)[0]);
  assert.match(t, /te estoy esperando en nuestra llamada de las 3:00 pm, hora Colombia/);
  assert.match(t, /https:\/\/meet\.google\.com\/abc/);
  assert.match(t, /la reagendamos de una vez$/);
});

// ─── Scheduler (harness) ──────────────────────────────────────────────────────

// `prefired`: claves (uri / hubspot:<id>) cuyo toque 1 ya salió. Se comparte por referencia, así
// el test ve lo que marca la red del corte (§18.CW).
function montar({ events, nowMs = NOW, lotes = [], confirmaciones = {}, prefired = new Set(), push0Enviados = [], optins = [LUCAS_PHONE] } = {}) {
  const h = installHarness(scheduler, { events, optins, nowMs });
  scheduler.__setDeps({
    ...h.deps,
    guardarLoteConfirmacion(filas) {
      lotes.push({ filas, enviadosAntes: h.wa.sent.length });
    },
    getConfirmacionDeCita: (uuid) => confirmaciones[uuid] || null,
    getPush1PrefiredKeys: () => new Set(prefired),
    markPush1Prefired: (keys) => keys.forEach((k) => prefired.add(k)),
    getPush0EnviadosPorMinuto: () => new Set(push0Enviados),
  });
  return h;
}
const uriDe = (uuid) => `https://api.calendly.com/scheduled_events/${uuid}`;

const citasManana = () => [
  makeEvent({ uuid: 'm-tarde', startIso: MANANA_3PM, closerEmail: LUCAS, prospectName: 'Laura Ríos', nowMs: NOW }),
  makeEvent({ uuid: 'm-temprano', startIso: MANANA_10AM, closerEmail: LUCAS, prospectName: 'Ana Gómez', nowMs: NOW }),
];

test('víspera con la bandera: pregunta de corte, sin digest de links, lote tipo corte con teléfono', async () => {
  process.env.CALENDLY_PLAYBOOK = PLAYBOOK;
  const lotes = [];
  // Las dos ya recibieron su toque 1 al agendar: la red del corte (§18.CW) no tiene nada que hacer.
  const h = montar({ events: citasManana(), lotes, prefired: new Set([uriDe('m-tarde'), uriDe('m-temprano')]) });

  await scheduler.runPush1Early();
  await scheduler.runPush1();
  assert.equal(h.wa.sent.length, 0, 'el Push 1 de siempre no sale para el playbook');

  await scheduler.runPlaybookCorte();
  assert.equal(h.wa.sent.length, 1);
  assert.match(h.wa.sent[0].text, /¿quiénes te confirmaron para mañana\?/);
  assert.equal(links(h.wa.sent[0].text).length, 0);
  assert.equal(lotes.length, 1);
  assert.equal(lotes[0].enviadosAntes, 0, 'el lote se guarda antes de preguntar');
  const filas = lotes[0].filas;
  assert.deepEqual(filas.map((f) => f.event_uuid), ['m-temprano', 'm-tarde']);
  assert.ok(filas.every((f) => f.tipo === 'corte' && f.lead_phone && f.lote.endsWith(':corte')));
});

test('sin la bandera: el Push 1 sale como siempre y no hay corte', async () => {
  const lotes = [];
  const h = montar({ events: citasManana(), lotes });
  await scheduler.runPlaybookCorte();
  assert.equal(h.wa.sent.length, 0);
  await scheduler.runPush1Early();
  await scheduler.runPush1();
  assert.equal(h.wa.sent.length, 1);
  assert.match(h.wa.sent[0].text, /Push 1/);
  assert.equal(lotes.length, 0);
});

test('el Push 2 no sale para una conexión con el playbook', async () => {
  process.env.CALENDLY_PLAYBOOK = PLAYBOOK;
  const hoy = makeEvent({ uuid: 'h1', startIso: '2026-06-15T20:00:00.000Z', closerEmail: LUCAS, nowMs: NOW });
  const h = montar({ events: [hoy] });
  await scheduler.runPush2();
  assert.equal(h.wa.sent.length, 0);
});

test('toque 2: lista las de pasado mañana y se salta las reservadas hace menos de 12 h', async () => {
  process.env.CALENDLY_PLAYBOOK = PLAYBOOK;
  const vieja = makeEvent({ uuid: 'p-vieja', startIso: PASADO_3PM, closerEmail: LUCAS, prospectName: 'Ana Gómez', nowMs: NOW });
  const nueva = makeEvent({ uuid: 'p-nueva', startIso: '2026-06-17T21:00:00.000Z', closerEmail: LUCAS, prospectName: 'Beto Ruiz', createdInMin: -60, nowMs: NOW });
  const h = montar({ events: [vieja, nueva, ...citasManana()] });
  await scheduler.runPlaybook48h();
  assert.equal(h.wa.sent.length, 1);
  const msg = h.wa.sent[0].text;
  assert.match(msg, /Toque 2 · 48 h antes/);
  assert.match(msg, /tienes 1 llamada/);
  assert.match(msg, /Ana Gómez/);
  assert.doesNotMatch(msg, /Beto Ruiz|Laura Ríos/);
  assert.match(texto(links(msg)[0]), /Respóndeme \*SÍ\*/);
});

test('poll: con la bandera el Push 3 vence 1 h antes y nace el Push 7 a los +10 min', async () => {
  process.env.CALENDLY_PLAYBOOK = PLAYBOOK;
  const ev = makeEvent({ uuid: 'c1', startIso: MANANA_10AM, closerEmail: LUCAS, nowMs: NOW });
  const h = montar({ events: [ev] });
  await scheduler.runCalendlyPoll();
  const p3 = h.store._rows.find((r) => r.push_n === 3);
  const p7 = h.store._rows.find((r) => r.push_n === 7);
  assert.equal(p3.due_at, '2026-06-16 14:00:00');
  assert.equal(p7.due_at, '2026-06-16 15:10:00');
});

test('poll sin la bandera: Push 3 a 25 min y sin Push 7', async () => {
  const ev = makeEvent({ uuid: 'c1', startIso: MANANA_10AM, closerEmail: LUCAS, nowMs: NOW });
  const h = montar({ events: [ev] });
  await scheduler.runCalendlyPoll();
  assert.equal(h.store._rows.find((r) => r.push_n === 3).due_at, '2026-06-16 14:35:00');
  assert.equal(h.store._rows.filter((r) => r.push_n === 7).length, 0);
});

test('entrega: el corte frena el Push 3 y el Push 7 de una sin confirmar; la confirmada sale', async () => {
  process.env.CALENDLY_PLAYBOOK = PLAYBOOK;
  const a = makeEvent({ uuid: 'ok', startIso: MANANA_10AM, closerEmail: LUCAS, prospectName: 'Ana Gómez', nowMs: NOW });
  const b = makeEvent({ uuid: 'no', startIso: '2026-06-16T15:30:00.000Z', closerEmail: LUCAS, prospectName: 'Beto Ruiz', nowMs: NOW });
  const h = montar({
    events: [a, b],
    confirmaciones: { ok: { tipo: 'corte', estado: 'confirmada' }, no: { tipo: 'corte', estado: 'no_confirmada' } },
  });
  await scheduler.runCalendlyPoll();

  h.clock.ms = Date.parse('2026-06-16T14:31:00.000Z'); // pasaron los dos Push 3
  await scheduler.runCalendlyDelivery();
  const push3 = h.wa.sent.filter((m) => /Push 3/.test(m.text));
  assert.equal(push3.length, 1);
  assert.match(push3[0].text, /Ana Gómez/);
  assert.match(texto(links(push3[0].text)[0]), /Te espero a las 10:00 am, hora Colombia/);
  const frenado = h.store._rows.find((r) => r.event_uuid === 'no' && r.push_n === 3);
  assert.equal(frenado.status, 'skipped');
  assert.equal(frenado.skip_reason, 'sin-confirmar');

  h.clock.ms = Date.parse('2026-06-16T15:12:00.000Z'); // +12 de la confirmada
  await scheduler.runCalendlyDelivery();
  h.clock.ms = Date.parse('2026-06-16T15:42:00.000Z'); // +12 de la sin confirmar
  await scheduler.runCalendlyDelivery();
  const push7 = h.wa.sent.filter((m) => /se conectó\?/.test(m.text));
  assert.equal(push7.length, 1);
  assert.match(push7[0].text, /Ana Gómez/);
  assert.equal(h.store._rows.find((r) => r.event_uuid === 'no' && r.push_n === 7).skip_reason, 'sin-confirmar');
});

test('entrega: un Push 7 atrasado más de media hora no sale', async () => {
  process.env.CALENDLY_PLAYBOOK = PLAYBOOK;
  const ev = makeEvent({ uuid: 'c1', startIso: MANANA_10AM, closerEmail: LUCAS, nowMs: NOW });
  const h = montar({ events: [ev] });
  await scheduler.runCalendlyPoll();
  for (const r of h.store._rows) if (r.push_n !== 7) r.status = 'sent';
  h.clock.ms = Date.parse('2026-06-16T15:45:00.000Z');
  await scheduler.runCalendlyDelivery();
  assert.equal(h.wa.sent.length, 0);
  assert.equal(h.store._rows.find((r) => r.push_n === 7).skip_reason, 'obsoleto');
});

// ─── 30X en producción: HubSpot como fuente única (§18.CO) ────────────────────

const OWNER_ID = '77002';
const reunion = ({ id = 'm1', startIso }) => ({
  id,
  properties: {
    hubspot_owner_id: OWNER_ID,
    hs_meeting_title: 'Entrevista de Postulación Programa AI Second Brain',
    hs_meeting_start_time: String(Date.parse(startIso)),
    hs_video_conference_url: 'https://meet.google.com/hub-spot-aaa',
    hs_createdate: new Date(NOW - 3 * 86400000).toISOString(),
  },
});

function montarHubspot({ meetings, lotes = [], nowMs = NOW, prefired = null }) {
  process.env.HUBSPOT_FUENTE_CONEXIONES = '30x';
  const h = installHarness(scheduler, { events: [], optins: [LUCAS_PHONE], nowMs });
  scheduler.__setDeps({
    ...h.deps,
    hubspotEnabled: () => true,
    async getOwnerEmailMap() {
      return { [OWNER_ID]: LUCAS };
    },
    async searchMeetingsInWindow({ fromIso, untilIso }) {
      return meetings.filter((m) => {
        const t = Number(m.properties.hs_meeting_start_time);
        return t >= Date.parse(fromIso) && t < Date.parse(untilIso);
      });
    },
    async getMeetingContact() {
      return { name: 'Beto Ruiz', phone: '+573001112222' };
    },
    getScheduledCallsInWindow: () => h.store._rows.map((r) => ({ closer_email: r.closer_email, call_start: r.call_start })),
    async getMeetingStrict(id) {
      return { found: true, meeting: meetings.find((m) => m.id === id) };
    },
    guardarLoteConfirmacion(filas) {
      lotes.push({ filas });
    },
    getConfirmacionDeCita: () => null,
    ...(prefired && {
      getPush1PrefiredKeys: () => new Set(prefired),
      markPush1Prefired: (keys) => keys.forEach((k) => prefired.add(k)),
    }),
  });
  return h;
}

test('HubSpot: el corte lista la reunión del assigner con el teléfono del contacto', async () => {
  process.env.CALENDLY_PLAYBOOK = PLAYBOOK;
  const lotes = [];
  const h = montarHubspot({ meetings: [reunion({ startIso: MANANA_3PM })], lotes, prefired: new Set(['hubspot:m1']) });
  await scheduler.runPlaybookCorte();
  assert.equal(h.wa.sent.length, 1);
  assert.match(h.wa.sent[0].text, /1\. 03:00\sp\.\sm\. — Beto Ruiz/);
  assert.deepEqual(
    lotes[0].filas.map((f) => [f.event_uuid, f.tipo, f.lead_phone]),
    [['hubspot:m1', 'corte', '+573001112222']]
  );
  delete process.env.HUBSPOT_FUENTE_CONEXIONES;
});

test('HubSpot: el poll agenda el Push 3 a 1 h y el Push 7, que sale con el link de la reunión', async () => {
  process.env.CALENDLY_PLAYBOOK = PLAYBOOK;
  const nowMs = Date.parse('2026-06-16T13:00:00.000Z');
  const h = montarHubspot({ meetings: [reunion({ startIso: MANANA_10AM })], nowMs });
  await scheduler.runHubspotAgendaPoll();
  const p3 = h.store._rows.find((r) => r.event_uuid === 'hubspot:m1' && r.push_n === 3);
  const p7 = h.store._rows.find((r) => r.event_uuid === 'hubspot:m1' && r.push_n === 7);
  assert.equal(p3.due_at, '2026-06-16 14:00:00');
  assert.equal(p7.due_at, '2026-06-16 15:10:00');

  for (const r of h.store._rows) if (r.push_n !== 7) r.status = 'sent';
  h.clock.ms = Date.parse('2026-06-16T15:11:00.000Z');
  await scheduler.runCalendlyDelivery();
  assert.equal(h.wa.sent.length, 1);
  assert.match(h.wa.sent[0].text, /¿Beto Ruiz se conectó\?/);
  assert.match(texto(links(h.wa.sent[0].text)[0]), /https:\/\/meet\.google\.com\/hub-spot-aaa/);
  delete process.env.HUBSPOT_FUENTE_CONEXIONES;
});

// ─── Catcher de la transición (§18.CV) ────────────────────────────────────────

test('toque 2: el digest de 48 h dice el día de la llamada', async () => {
  process.env.CALENDLY_PLAYBOOK = PLAYBOOK;
  const ev = makeEvent({ uuid: 'p1', startIso: PASADO_3PM, closerEmail: LUCAS, prospectName: 'Ana Gómez', nowMs: NOW });
  const h = montar({ events: [ev] });
  await scheduler.runPlaybook48h();
  assert.match(texto(links(h.wa.sent[0].text)[0]), /tu llamada del miércoles 17 a las 3:00 pm, hora Colombia/);
});

// Activación a las 9:40 de hoy (después de los toques de las 8am).
const DESDE = '2026-06-15T14:40:00.000Z';

function montarCatcher({ meetings, optins = [LUCAS_PHONE], prefiredIniciales = [], push3SinPush7 = [], push0Enviados = [] }) {
  process.env.CALENDLY_PLAYBOOK = PLAYBOOK;
  process.env.CALENDLY_PLAYBOOK_RESCATE_DESDE = DESDE;
  process.env.HUBSPOT_FUENTE_CONEXIONES = '30x';
  const h = installHarness(scheduler, { events: [], optins, nowMs: Date.parse('2026-06-15T15:00:00.000Z') });
  const settings = new Map();
  const prefired = new Set(prefiredIniciales);
  const lotes = [];
  scheduler.__setDeps({
    ...h.deps,
    hubspotEnabled: () => true,
    async getOwnerEmailMap() {
      return { [OWNER_ID]: LUCAS };
    },
    async searchMeetingsInWindow({ fromIso, untilIso }) {
      return meetings.filter((m) => {
        const t = Number(m.properties.hs_meeting_start_time);
        return t >= Date.parse(fromIso) && t < Date.parse(untilIso);
      });
    },
    async getMeetingContact(id) {
      return { name: id === 'm2' ? 'Caro Díaz' : 'Beto Ruiz', phone: '+573001112222' };
    },
    getScheduledCallsInWindow: () => [],
    getPush1PrefiredKeys: () => new Set(prefired),
    markPush1Prefired: (keys) => keys.forEach((k) => prefired.add(k)),
    getSetting: (k) => settings.get(k) || null,
    setSetting: (k, v) => settings.set(k, v),
    getPush3SinPush7: () => push3SinPush7.splice(0),
    getPush0EnviadosPorMinuto: () => new Set(push0Enviados),
    guardarLoteConfirmacion: (filas) => lotes.push(filas),
    getConfirmacionDeCita: () => null,
  });
  return { h, settings, prefired, lotes };
}
const reunionCreada = ({ id, startIso, creada }) => {
  const m = reunion({ id, startIso });
  m.properties.hs_createdate = creada;
  return m;
};

test('catcher: manda la bienvenida de las citas viejas sin toque 1, marca prefired y se apaga solo', async () => {
  const meetings = [
    reunionCreada({ id: 'm1', startIso: '2026-06-20T20:00:00.000Z', creada: '2026-06-01T12:00:00.000Z' }),
    // reservada DESPUÉS de prender el playbook: su toque 1 ya salió al agendar
    reunionCreada({ id: 'm2', startIso: '2026-06-21T20:00:00.000Z', creada: '2026-06-15T14:50:00.000Z' }),
    // ya recibió su Push 1 al agendar (prueba §18.CK)
    reunionCreada({ id: 'm3', startIso: '2026-06-22T20:00:00.000Z', creada: '2026-06-02T12:00:00.000Z' }),
  ];
  const { h, settings, prefired } = montarCatcher({ meetings, prefiredIniciales: ['hubspot:m3'] });
  const r = await scheduler.runPlaybookRescate();
  const rescate = h.wa.sent.filter((m) => /Rescate del playbook/.test(m.text));
  assert.equal(rescate.length, 1);
  assert.equal(links(rescate[0].text).length, 1, 'solo la cita vieja sin toque 1');
  assert.match(rescate[0].text, /sáb, 20 de jun/);
  assert.match(texto(links(rescate[0].text)[0]), /Ya quedó agendada tu llamada[^]*el sábado 20 de junio a las 3:00 pm/);
  assert.ok(prefired.has('hubspot:m1'));
  assert.equal(r.encontradas, 1);
  assert.ok(settings.get('playbook_rescate:catchup'), 'corrió los toques de hoy');
  assert.equal(settings.get('playbook_rescate:fin'), undefined, 'todavía no termina en la corrida que manda');

  const antes = h.wa.sent.length;
  await scheduler.runPlaybookRescate();
  assert.equal(h.wa.sent.length, antes, 'la segunda corrida no manda nada');
  assert.ok(settings.get('playbook_rescate:fin'), 'sin pendientes se apaga');
  assert.deepEqual(await scheduler.runPlaybookRescate(), { activo: false, terminado: true });
});

test('catcher: un closer sin opt-in queda pendiente y no se apaga', async () => {
  const meetings = [reunionCreada({ id: 'm1', startIso: '2026-06-20T20:00:00.000Z', creada: '2026-06-01T12:00:00.000Z' })];
  const { settings, prefired } = montarCatcher({ meetings, optins: [] });
  const r = await scheduler.runPlaybookRescate();
  assert.equal(r.pendientes, 1);
  assert.ok(!prefired.has('hubspot:m1'));
  await scheduler.runPlaybookRescate();
  assert.equal(settings.get('playbook_rescate:fin'), undefined);
});

test('catcher: crea el Push 7 de las citas que ya tenían Push 3; sin la fecha de activación no hace nada', async () => {
  const fila = {
    event_uuid: 'hubspot:m9', push_n: 3, program: 'second_brain', closer_email: LUCAS, closer_phone: LUCAS_PHONE,
    prospect_name: 'Beto Ruiz', prospect_phone: '+573001112222', call_start: '2026-06-16 15:00:00',
  };
  const { h } = montarCatcher({ meetings: [], push3SinPush7: [fila] });
  const r = await scheduler.runPlaybookRescate();
  assert.equal(r.push7, 1);
  const p7 = h.store._rows.find((x) => x.push_n === 7);
  assert.equal(p7.due_at, '2026-06-16 15:10:00');
  assert.match(p7.message, /¿Beto Ruiz se conectó\?/);

  delete process.env.CALENDLY_PLAYBOOK_RESCATE_DESDE;
  assert.deepEqual(await scheduler.runPlaybookRescate(), { activo: false });
  delete process.env.HUBSPOT_FUENTE_CONEXIONES;
});

test('catcher: no repite una cita cuyo Push 0 ya salió con otra clave (reservada por Calendly)', async () => {
  const meetings = [reunionCreada({ id: 'm1', startIso: '2026-06-20T20:00:00.000Z', creada: '2026-06-01T12:00:00.000Z' })];
  const { h } = montarCatcher({ meetings, push0Enviados: [`${LUCAS}|2026-06-20 20:00`] });
  const r = await scheduler.runPlaybookRescate();
  assert.equal(r.encontradas, 0);
  assert.equal(h.wa.sent.filter((m) => /Rescate/.test(m.text)).length, 0);
});

// ─── Red permanente del corte (§18.CW) ────────────────────────────────────────

const bienvenidas = (h) => h.wa.sent.filter((m) => /Bienvenida pendiente/.test(m.text));
const PREGUNTA = /¿quiénes te confirmaron para mañana\?/;

test('red del corte: la cita de mañana sin toque 1 recibe su bienvenida antes de la pregunta y queda prefired', async () => {
  process.env.CALENDLY_PLAYBOOK = PLAYBOOK;
  const prefired = new Set([uriDe('m-tarde')]); // Laura recibió su toque 1 al agendar; Ana no
  const lotes = [];
  const h = montar({ events: citasManana(), lotes, prefired });

  await scheduler.runPlaybookCorte();
  assert.equal(h.wa.sent.length, 2);
  const [bienvenida, pregunta] = h.wa.sent;
  assert.match(bienvenida.text, /Bienvenida pendiente/);
  assert.match(bienvenida.text, /Ana Gómez/);
  assert.doesNotMatch(bienvenida.text, /Laura Ríos/);
  assert.equal(links(bienvenida.text).length, 1);
  assert.match(texto(links(bienvenida.text)[0]), /Ya quedó agendada tu llamada[^]*mañana a las 10:00 am/);
  assert.match(pregunta.text, PREGUNTA);
  assert.deepEqual(lotes[0].filas.map((f) => f.event_uuid), ['m-temprano', 'm-tarde'], 'la pregunta sigue listando todas');
  assert.ok(prefired.has(uriDe('m-temprano')), 'lo entregado queda marcado');

  // Un segundo corte (reintento a mano) no la repite.
  await scheduler.runPlaybookCorte();
  assert.equal(bienvenidas(h).length, 1);
});

test('red del corte: un Push 0 ya enviado al mismo closer en el mismo minuto cuenta como toque 1', async () => {
  process.env.CALENDLY_PLAYBOOK = PLAYBOOK;
  const h = montar({
    events: citasManana(),
    prefired: new Set([uriDe('m-tarde')]),
    push0Enviados: [`${LUCAS}|2026-06-16 15:00`],
  });
  await scheduler.runPlaybookCorte();
  assert.equal(bienvenidas(h).length, 0);
  assert.equal(h.wa.sent.length, 1);
});

test('red del corte: sin opt-in no sale nada ni se marca prefired', async () => {
  process.env.CALENDLY_PLAYBOOK = PLAYBOOK;
  const prefired = new Set();
  const h = montar({ events: citasManana(), prefired, optins: [] });
  await scheduler.runPlaybookCorte();
  assert.equal(h.wa.sent.length, 0);
  assert.equal(prefired.size, 0);
});

test('red del corte: más de 8 citas sin toque 1 van en tandas, todas antes de la pregunta', async () => {
  process.env.CALENDLY_PLAYBOOK = PLAYBOOK;
  const events = Array.from({ length: 10 }, (_, i) =>
    makeEvent({
      uuid: `t${i}`,
      startIso: new Date(Date.parse(MANANA_10AM) + i * 1800000).toISOString(),
      closerEmail: LUCAS,
      prospectName: `Lead ${i}`,
      nowMs: NOW,
    })
  );
  const prefired = new Set();
  const h = montar({ events, prefired });
  await scheduler.runPlaybookCorte();
  assert.equal(h.wa.sent.length, 3);
  assert.match(h.wa.sent[0].text, /Bienvenida pendiente \(1\/2\)/);
  assert.equal(links(h.wa.sent[0].text).length, 8);
  assert.match(h.wa.sent[1].text, /Bienvenida pendiente \(2\/2\)/);
  assert.equal(links(h.wa.sent[1].text).length, 2);
  assert.match(h.wa.sent[2].text, PREGUNTA);
  assert.equal(prefired.size, 10);
});

test('red del corte: la reunión del assigner (HubSpot) sin toque 1 también la recibe', async () => {
  process.env.CALENDLY_PLAYBOOK = PLAYBOOK;
  const prefired = new Set();
  const h = montarHubspot({ meetings: [reunion({ startIso: MANANA_3PM })], prefired });
  await scheduler.runPlaybookCorte();
  assert.equal(h.wa.sent.length, 2);
  assert.match(h.wa.sent[0].text, /Bienvenida pendiente[^]*Beto Ruiz/);
  assert.match(h.wa.sent[1].text, PREGUNTA);
  assert.ok(prefired.has('hubspot:m1'));
  delete process.env.HUBSPOT_FUENTE_CONEXIONES;
});

test('red del corte: el corte que recupera el catcher el día de la activación no la manda', async () => {
  // Esas citas de mañana ya tuvieron el Push 1 de las 8am del régimen viejo, sin marca de prefired.
  const meetings = [reunionCreada({ id: 'm1', startIso: MANANA_3PM, creada: '2026-06-01T12:00:00.000Z' })];
  const { h, lotes } = montarCatcher({ meetings });
  await scheduler.runPlaybookRescate();
  assert.equal(bienvenidas(h).length, 0);
  assert.equal(h.wa.sent.filter((m) => PREGUNTA.test(m.text)).length, 1);
  assert.equal(lotes.length, 1);
  delete process.env.HUBSPOT_FUENTE_CONEXIONES;
});

// ─── Recordatorio del corte a las 2pm (§18.CW) ────────────────────────────────

test('recordatorio del corte: copy con los mismos números de la mañana', () => {
  const msg = buildCorteRecordatorio({
    filas: [
      { posicion: 1, lead_name: 'Ana Gómez', call_start: '2026-06-16 15:00:00' },
      { posicion: 2, lead_name: null, call_start: '2026-06-16 20:00:00' },
    ],
    tz: 'America/Bogota',
  });
  assert.match(msg, /Te falta el corte de mañana/);
  assert.match(msg, /1\. 10:00\sa\.\sm\. — Ana Gómez/);
  assert.match(msg, /2\. 03:00\sp\.\sm\. — el prospecto/);
  assert.match(msg, /\*todos\*/);
});

function montarRecordatorio({ cortes, optins = [LUCAS_PHONE] }) {
  const h = installHarness(scheduler, { events: [], optins, nowMs: Date.parse('2026-06-15T19:00:00.000Z') });
  const recordados = [];
  const fechas = [];
  scheduler.__setDeps({
    ...h.deps,
    getCortesSinRespuesta: (fecha) => {
      fechas.push(fecha);
      return cortes;
    },
    markCorteRecordado: (lote) => recordados.push(lote),
  });
  return { h, recordados, fechas };
}
const filaCorte = (over) => ({
  lote: `${LUCAS_PHONE}:2026-06-15:corte`,
  closer_email: LUCAS,
  closer_phone: LUCAS_PHONE,
  lead_name: 'Ana Gómez',
  call_start: '2026-06-16 15:00:00',
  posicion: 1,
  ...over,
});

test('recordatorio del corte: un mensaje por lote sin respuesta, con la fecha de hoy, y lo marca', async () => {
  process.env.CALENDLY_PLAYBOOK = PLAYBOOK;
  const cortes = [filaCorte({}), filaCorte({ posicion: 2, lead_name: 'Laura Ríos', call_start: '2026-06-16 20:00:00' })];
  const { h, recordados, fechas } = montarRecordatorio({ cortes });
  assert.equal(await scheduler.runPlaybookRecordatorioCorte(), 1);
  assert.deepEqual(fechas, ['2026-06-15']);
  assert.equal(h.wa.sent.length, 1);
  assert.match(h.wa.sent[0].text, /1\. 10:00\sa\.\sm\. — Ana Gómez\n2\. 03:00\sp\.\sm\. — Laura Ríos/);
  assert.deepEqual(recordados, [`${LUCAS_PHONE}:2026-06-15:corte`]);
});

test('recordatorio del corte: sin opt-in no se marca; sin la bandera no hace nada', async () => {
  process.env.CALENDLY_PLAYBOOK = PLAYBOOK;
  const { h, recordados } = montarRecordatorio({ cortes: [filaCorte({})], optins: [] });
  assert.equal(await scheduler.runPlaybookRecordatorioCorte(), 0);
  assert.equal(recordados.length, 0);

  delete process.env.CALENDLY_PLAYBOOK;
  assert.equal(await scheduler.runPlaybookRecordatorioCorte(), 0);
  assert.equal(h.wa.sent.length, 0);
});
