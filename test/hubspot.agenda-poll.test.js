// Tests PUROS del poll de citas que solo viven en HubSpot (src/hubspot/agenda-poll.js).
//
// Lo que se fija acá NO es "que agende", es **que no agende de más**. El riesgo de este feature
// es mandarle al closer el mismo aviso dos veces (una por Calendly, otra por HubSpot), y eso es
// peor que perder el aviso: quema la confianza en Juanito y es el patrón que enoja a WhatsApp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickMeetingsToSchedule,
  callKey,
  callStartToIso,
  programLivesInThisHubspot,
  withinWorkingHours,
  localHourOf,
} from '../src/hubspot/agenda-poll.js';

const hs = (over = {}) => ({
  event_uuid: 'hubspot:m1',
  meeting_id: 'm1',
  program: 'second_brain',
  closer_email: 'pablo.lozano@30x.com',
  call_start: '2026-07-28 15:00:00',
  prospect_name: 'Entrevista de Postulación Programa AI Second Brain',
  ...over,
});

const yaAgendada = (over = {}) => ({
  event_uuid: 'cal-uuid',
  program: 'second_brain',
  closer_email: 'pablo.lozano@30x.com',
  call_start: '2026-07-28 15:00:00',
  ...over,
});

// ─── El caso que justifica el feature ─────────────────────────────────────────

test('una cita que solo está en HubSpot SÍ se agenda', () => {
  const { toSchedule } = pickMeetingsToSchedule({ hubspotCalls: [hs()], existingCalls: [] });
  assert.equal(toSchedule.length, 1);
  assert.equal(toSchedule[0].event_uuid, 'hubspot:m1');
});

// ─── Las tres capas de exclusión ──────────────────────────────────────────────

test('si la call YA tiene push (vino de Calendly) no se agenda de nuevo', () => {
  const { toSchedule, skipped } = pickMeetingsToSchedule({
    hubspotCalls: [hs()],
    existingCalls: [yaAgendada()],
  });
  assert.equal(toSchedule.length, 0, 'doble push al mismo closer por la misma call');
  assert.equal(skipped.yaAgendado, 1);
});

test('el dedup tolera segundos distintos entre fuentes (compara al minuto)', () => {
  const { toSchedule } = pickMeetingsToSchedule({
    hubspotCalls: [hs({ call_start: '2026-07-28 15:00:45' })],
    existingCalls: [yaAgendada({ call_start: '2026-07-28 15:00:00' })],
  });
  assert.equal(toSchedule.length, 0);
});

test('el dedup ignora mayúsculas del email', () => {
  const { toSchedule } = pickMeetingsToSchedule({
    hubspotCalls: [hs({ closer_email: 'Pablo.Lozano@30x.com' })],
    existingCalls: [yaAgendada()],
  });
  assert.equal(toSchedule.length, 0);
});

test('HubSpot con VARIOS registros de la misma call agenda UNO solo', () => {
  // Caso real medido (2026-07-27): un lead con 3 meetings al mismo minuto. Si cada `meeting.id`
  // valiera por una call, el closer recibiría tres avisos idénticos.
  const { toSchedule, skipped } = pickMeetingsToSchedule({
    hubspotCalls: [
      hs({ event_uuid: 'hubspot:a', meeting_id: 'a' }),
      hs({ event_uuid: 'hubspot:b', meeting_id: 'b' }),
      hs({ event_uuid: 'hubspot:c', meeting_id: 'c' }),
    ],
    existingCalls: [],
  });
  assert.equal(toSchedule.length, 1);
  assert.equal(skipped.duplicado, 2);
});

test('un programa de OTRA empresa nunca se agenda desde este CRM', () => {
  // Retia tiene su propio Calendly y no vive en este HubSpot: si un título llegara a matchear,
  // le mandaríamos a su closer un push derivado del CRM de otra empresa.
  const { toSchedule, skipped } = pickMeetingsToSchedule({
    hubspotCalls: [hs({ program: 'tactical_investor', closer_email: 'registro@ttrading.co' })],
    existingCalls: [],
  });
  assert.equal(toSchedule.length, 0);
  assert.equal(skipped.programa, 1);
  assert.equal(programLivesInThisHubspot('tactical_investor'), false);
  assert.equal(programLivesInThisHubspot('second_brain'), true);
});

test('sin programa reconocido tampoco entra', () => {
  const { toSchedule } = pickMeetingsToSchedule({ hubspotCalls: [hs({ program: null })], existingCalls: [] });
  assert.equal(toSchedule.length, 0);
});

// ─── Guardarraíl de horario ───────────────────────────────────────────────────

test('una cita a medianoche NO recibe push, y se devuelve para loguearla', () => {
  // Caso real (2026-07-27): 1 de 169 calls de HubSpot caía a las 00:00 Bogotá — un marcador de
  // seguimiento, no una llamada. Su Push 3 le habría llegado al closer 23:35 de la noche.
  const medianoche = hs({ call_start: '2026-07-28 05:00:00' }); // 00:00 en Bogotá
  const { toSchedule, skipped, fueraDeHorario } = pickMeetingsToSchedule({
    hubspotCalls: [medianoche],
    existingCalls: [],
  });
  assert.equal(toSchedule.length, 0);
  assert.equal(skipped.fueraDeHorario, 1);
  assert.equal(fueraDeHorario.length, 1, 'se devuelve para el log: un descarte mudo sería el bug');
});

test('el horario laboral real sí pasa', () => {
  // 15:00 UTC = 10:00 Bogotá, la franja más cargada del equipo.
  const { toSchedule } = pickMeetingsToSchedule({ hubspotCalls: [hs()], existingCalls: [] });
  assert.equal(toSchedule.length, 1);
  assert.equal(localHourOf('2026-07-28 15:00:00'), 10);
  assert.equal(withinWorkingHours('2026-07-28 12:00:00'), true); // 07:00 Bogotá — la más temprana real
  assert.equal(withinWorkingHours('2026-07-29 00:00:00'), true); // 19:00 Bogotá — la más tardía real
});

test('los bordes de la ventana laboral', () => {
  // La ventana es [06:00, 22:00) hora Bogotá (UTC-5).
  assert.equal(withinWorkingHours('2026-07-28 11:00:00'), true, '06:00 entra');
  assert.equal(withinWorkingHours('2026-07-28 10:59:00'), false, '05:59 no');
  assert.equal(withinWorkingHours('2026-07-29 02:59:00'), true, '21:59 entra');
  assert.equal(withinWorkingHours('2026-07-29 03:00:00'), false, '22:00 no');
  assert.equal(withinWorkingHours('no-es-fecha'), false);
});

// ─── Lo que NO debe excluir ───────────────────────────────────────────────────

test('mismo minuto pero closers distintos son dos calls distintas', () => {
  const { toSchedule } = pickMeetingsToSchedule({
    hubspotCalls: [hs({ event_uuid: 'hubspot:x', closer_email: 'sebastian@30x.com' })],
    existingCalls: [yaAgendada()], // Pablo a la misma hora
  });
  assert.equal(toSchedule.length, 1, 'la call de Sebastian no la cubre el push de Pablo');
});

test('el mismo closer con dos calls a horas distintas recibe las dos', () => {
  const { toSchedule } = pickMeetingsToSchedule({
    hubspotCalls: [hs({ event_uuid: 'hubspot:1' }), hs({ event_uuid: 'hubspot:2', call_start: '2026-07-28 16:00:00' })],
    existingCalls: [],
  });
  assert.equal(toSchedule.length, 2);
});

test('sale ordenado por hora: lo más próximo primero', () => {
  const { toSchedule } = pickMeetingsToSchedule({
    hubspotCalls: [
      hs({ event_uuid: 'hubspot:tarde', call_start: '2026-07-28 20:00:00' }),
      hs({ event_uuid: 'hubspot:temprano', call_start: '2026-07-28 13:00:00' }),
    ],
    existingCalls: [],
  });
  assert.deepEqual(toSchedule.map((c) => c.event_uuid), ['hubspot:temprano', 'hubspot:tarde']);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

test('callKey normaliza email y corta al minuto', () => {
  assert.equal(callKey(' Pablo@30X.com ', '2026-07-28 15:00:45'), 'pablo@30x.com|2026-07-28 15:00');
});

test('callStartToIso convierte el formato de SQLite y rechaza basura', () => {
  assert.equal(callStartToIso('2026-07-28 15:00:00'), '2026-07-28T15:00:00Z');
  assert.equal(callStartToIso('no-es-fecha'), null);
  assert.equal(callStartToIso(null), null);
});

test('sin citas de HubSpot no hay nada que agendar', () => {
  const { toSchedule } = pickMeetingsToSchedule({});
  assert.equal(toSchedule.length, 0);
});
