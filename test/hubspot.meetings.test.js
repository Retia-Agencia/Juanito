// Tests PUROS de la unión de fuentes de la agenda (src/hubspot/meetings.js + programFromTitle).
//
// Lo que se fija acá es el motivo por el que la unión existe: ninguna de las dos fuentes ve
// todo. Calendly no ve las citas que el closer agenda a mano en HubSpot; HubSpot no ve los
// programas de otra empresa (Retia) ni a los closers que no son owners ahí.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetingsToCalls, mergeAgendaSources, meetingStartMs, toDbUtc } from '../src/hubspot/meetings.js';
import { programFromTitle } from '../src/calendly/programs.js';

const OWNERS = {
  100: 'sebastian@30x.com',
  101: 'pablo.lozano@30x.com',
  999: 'marketing@30x.com', // no es closer
};
const CLOSER_EMAILS = new Set(['sebastian@30x.com', 'pablo.lozano@30x.com']);
const opts = { ownerEmailById: OWNERS, closerEmails: CLOSER_EMAILS };

const meeting = ({ id = 'm1', owner = 100, title = 'Entrevista de Postulación Programa de Implementación AI Second Brain', start = '2026-07-24T15:00:00Z' }) => ({
  id,
  properties: { hubspot_owner_id: String(owner), hs_meeting_title: title, hs_meeting_start_time: start },
});

// ─── programFromTitle ─────────────────────────────────────────────────────────

test('programa derivado del título, con los naming reales de HubSpot', () => {
  assert.equal(programFromTitle('Entrevista de Postulación Programa de Implementación AI Second Brain'), 'second_brain');
  assert.equal(programFromTitle('Second Brain <> Mauricio Posada'), 'second_brain'); // formato corto
  assert.equal(programFromTitle('Entrevista de Postulación Programa Operaciones Escalables con IA'), 'operaciones');
  assert.equal(programFromTitle('Entrevista de postulación para el programa Instagram & TikTok'), 'instagram');
  assert.equal(programFromTitle('Seguimiento de Postulación Programa LinkedIn Sales 30X'), 'linkedin');
  assert.equal(programFromTitle('Entrevista de Postulación Programa AI for Developers 30X'), 'developers');
});

test('programFromTitle ignora acentos y mayúsculas', () => {
  assert.equal(programFromTitle('ENTREVISTA POSTULACION PROGRAMA IA PARA ABOGADOS'), 'abogados');
  assert.equal(programFromTitle('entrevista de postulación programa ia para abogádos'), 'abogados');
});

test('reunión interna → null (no es call de venta)', () => {
  // Estos tres son títulos REALES que aparecieron en la ventana de 7 días medida.
  assert.equal(programFromTitle('30X <> Revisión de reunión con equipo de IT'), null);
  assert.equal(programFromTitle('Punto de contacto 30X <> Casa Luker'), null);
  assert.equal(programFromTitle(''), null);
  assert.equal(programFromTitle(null), null);
});

// ─── meetingsToCalls ──────────────────────────────────────────────────────────

test('descarta meetings de quien no es closer', () => {
  const calls = meetingsToCalls([meeting({ owner: 999 })], opts);
  assert.equal(calls.length, 0, 'marketing@ no es closer → fuera');
});

test('descarta internas de un closer', () => {
  const calls = meetingsToCalls([meeting({ title: '30X <> Revisión con equipo de IT' })], opts);
  assert.equal(calls.length, 0);
});

test('traduce un meeting a fila de agenda con la forma de calendly_pushes', () => {
  const [c] = meetingsToCalls([meeting({ id: 'm42' })], opts);
  assert.equal(c.event_uuid, 'hubspot:m42');
  assert.equal(c.program, 'second_brain');
  assert.equal(c.closer_email, 'sebastian@30x.com');
  assert.equal(c.call_start, '2026-07-24 15:00:00'); // formato UTC de SQLite
  assert.equal(c.source, 'hubspot');
});

test('acepta hs_meeting_start_time como epoch ms o como ISO', () => {
  const ms = Date.parse('2026-07-24T15:00:00Z');
  assert.equal(meetingStartMs(String(ms)), ms);
  assert.equal(meetingStartMs('2026-07-24T15:00:00Z'), ms);
  assert.ok(Number.isNaN(meetingStartMs(null)));
  assert.ok(Number.isNaN(meetingStartMs('')));
  assert.equal(toDbUtc(ms), '2026-07-24 15:00:00');
  // Un meeting sin hora parseable no entra en ninguna agenda.
  assert.equal(meetingsToCalls([meeting({ start: 'no-es-fecha' })], opts).length, 0);
});

// ─── mergeAgendaSources ───────────────────────────────────────────────────────

const cal = (closer, start, program = 'second_brain') => ({
  event_uuid: `cal-${closer}-${start}`,
  program,
  closer_email: closer,
  call_start: start,
  source: 'calendly',
});

test('la misma call en las dos fuentes se cuenta UNA vez y gana Calendly', () => {
  const calendly = [cal('sebastian@30x.com', '2026-07-24 15:00:00')];
  const hubspot = meetingsToCalls([meeting({})], opts);
  const { calls, added, duplicates } = mergeAgendaSources(calendly, hubspot);
  assert.equal(calls.length, 1);
  assert.equal(added, 0);
  assert.equal(duplicates, 1);
  assert.equal(calls[0].source, 'calendly', 'Calendly manda: su programa viene del event_type');
});

test('la cita que SOLO está en HubSpot se suma', () => {
  const calendly = [cal('sebastian@30x.com', '2026-07-24 15:00:00')];
  const hubspot = meetingsToCalls([meeting({ id: 'm2', start: '2026-07-24T18:30:00Z' })], opts);
  const { calls, added } = mergeAgendaSources(calendly, hubspot);
  assert.equal(calls.length, 2);
  assert.equal(added, 1);
});

test('el dedup es por closer: misma hora, closers distintos, son dos calls', () => {
  const calendly = [cal('sebastian@30x.com', '2026-07-24 15:00:00')];
  const hubspot = meetingsToCalls([meeting({ id: 'm3', owner: 101 })], opts); // Pablo, misma hora
  const { calls, added } = mergeAgendaSources(calendly, hubspot);
  assert.equal(calls.length, 2);
  assert.equal(added, 1);
});

test('el dedup tolera segundos distintos entre fuentes (compara al minuto)', () => {
  const calendly = [cal('sebastian@30x.com', '2026-07-24 15:00:00')];
  const hubspot = meetingsToCalls([meeting({ start: '2026-07-24T15:00:45Z' })], opts);
  const { calls, duplicates } = mergeAgendaSources(calendly, hubspot);
  assert.equal(calls.length, 1);
  assert.equal(duplicates, 1);
});

test('sin HubSpot (lista vacía) la agenda queda igual que antes — degradación segura', () => {
  const calendly = [cal('sebastian@30x.com', '2026-07-24 15:00:00'), cal('pablo.lozano@30x.com', '2026-07-24 16:00:00')];
  const { calls, added } = mergeAgendaSources(calendly, []);
  assert.equal(calls.length, 2);
  assert.equal(added, 0);
});

test('los programas que HubSpot no cubre sobreviven a la unión', () => {
  // Retia (tactical_investor) y abogados no existen en el HubSpot conectado: si el merge los
  // perdiera, el reporte del jefe se quedaría sin dos programas enteros sin avisar.
  const calendly = [
    cal('registro@ttrading.co', '2026-07-24 17:00:00', 'tactical_investor'),
    cal('sebastian.salazar@30x.com', '2026-07-24 16:00:00', 'abogados'),
  ];
  const { calls } = mergeAgendaSources(calendly, meetingsToCalls([meeting({})], opts));
  const progs = calls.map((c) => c.program).sort();
  assert.deepEqual(progs, ['abogados', 'second_brain', 'tactical_investor']);
});

test('el resultado sale ordenado por hora', () => {
  const calendly = [cal('sebastian@30x.com', '2026-07-24 20:00:00')];
  const hubspot = meetingsToCalls([meeting({ id: 'm9', start: '2026-07-24T13:00:00Z' })], opts);
  const { calls } = mergeAgendaSources(calendly, hubspot);
  assert.deepEqual(calls.map((c) => c.call_start), ['2026-07-24 13:00:00', '2026-07-24 20:00:00']);
});
