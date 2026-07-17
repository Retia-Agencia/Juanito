// Tests PUROS del modelo nudge (src/hubspot/deals.js): mapa programa→pipeline y
// clasificación de etapa. Sin red ni DB → corren en cualquier lado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDealStage,
  pipelineForProgram,
  isCoveredProgram,
  programPipelines,
  pickDealForPipeline,
  decideFromAgenda,
  AGENDA_TO_ASISTENCIA,
} from '../src/hubspot/deals.js';

// Etapas reales de AI Second Brain (pipeline 904247681).
const SB_STAGES = [
  { stageId: '1368121616', label: 'Potencial', displayOrder: 0, isClosed: false },
  { stageId: '1368121619', label: 'Calificado', displayOrder: 4, isClosed: false },
  { stageId: '1368121620', label: 'Agendado', displayOrder: 5, isClosed: false },
  { stageId: '1368121621', label: 'Atendido', displayOrder: 6, isClosed: false },
  { stageId: '1368121622', label: 'Compromiso Verbal', displayOrder: 7, isClosed: false },
  { stageId: '1368121624', label: 'Ganado Pagado Completo', displayOrder: 9, isClosed: true },
  { stageId: '1368121625', label: 'Cierre perdido', displayOrder: 10, isClosed: true },
];

test('classify: Agendado tras pasar la call → stale (nudge)', () => {
  assert.equal(classifyDealStage('1368121620', SB_STAGES), 'stale');
});

test('classify: etapas antes de Agendado también son stale (no registrado)', () => {
  assert.equal(classifyDealStage('1368121619', SB_STAGES), 'stale');
});

test('classify: Atendido y Compromiso Verbal → resolved', () => {
  assert.equal(classifyDealStage('1368121621', SB_STAGES), 'resolved');
  assert.equal(classifyDealStage('1368121622', SB_STAGES), 'resolved');
});

test('classify: etapas cerradas (Ganado/Perdido) → resolved', () => {
  assert.equal(classifyDealStage('1368121624', SB_STAGES), 'resolved');
  assert.equal(classifyDealStage('1368121625', SB_STAGES), 'resolved');
});

test('classify: stage inexistente o sin etapas → unknown', () => {
  assert.equal(classifyDealStage('999', SB_STAGES), 'unknown');
  assert.equal(classifyDealStage('1368121620', []), 'unknown');
  assert.equal(classifyDealStage(null, SB_STAGES), 'unknown');
});

test('classify: pipeline sin etapa "Agendado" → unknown (no clasificable)', () => {
  const noAgendado = [
    { stageId: 'a', label: 'Nuevo', displayOrder: 0, isClosed: false },
    { stageId: 'b', label: 'Ganado', displayOrder: 1, isClosed: true },
  ];
  assert.equal(classifyDealStage('a', noAgendado), 'unknown');
});

test('cobertura: los 3 programas con pipeline aquí están cubiertos', () => {
  assert.equal(isCoveredProgram('second_brain'), true);
  assert.equal(isCoveredProgram('linkedin'), true);
  assert.equal(isCoveredProgram('operaciones'), true);
});

test('cobertura: developers y abogados NO están cubiertos → Push 4 clásico', () => {
  assert.equal(isCoveredProgram('developers'), false);
  assert.equal(isCoveredProgram('abogados'), false);
  assert.equal(pipelineForProgram('developers'), null);
});

test('mapa: override por env HUBSPOT_PROGRAM_PIPELINES', () => {
  const prev = process.env.HUBSPOT_PROGRAM_PIPELINES;
  process.env.HUBSPOT_PROGRAM_PIPELINES = 'developers:123, second_brain:904247681';
  try {
    const m = programPipelines();
    assert.equal(m.developers, '123');
    assert.equal(m.second_brain, '904247681');
    assert.equal(isCoveredProgram('developers'), true); // ahora sí, por override
  } finally {
    if (prev === undefined) delete process.env.HUBSPOT_PROGRAM_PIPELINES;
    else process.env.HUBSPOT_PROGRAM_PIPELINES = prev;
  }
});

test('pickDeal: filtra por pipeline y elige el modificado más reciente', () => {
  const deals = [
    { id: '1', properties: { pipeline: '904247681', hs_lastmodifieddate: '2026-07-01T00:00:00Z' } },
    { id: '2', properties: { pipeline: '904247681', hs_lastmodifieddate: '2026-07-10T00:00:00Z' } },
    { id: '3', properties: { pipeline: '999', hs_lastmodifieddate: '2026-07-20T00:00:00Z' } },
  ];
  assert.equal(pickDealForPipeline(deals, '904247681').id, '2');
});

test('pickDeal: sin deal en el pipeline → null', () => {
  const deals = [{ id: '3', properties: { pipeline: '999' } }];
  assert.equal(pickDealForPipeline(deals, '904247681'), null);
  assert.equal(pickDealForPipeline([], '904247681'), null);
});

// ─── Cosecha por agenda_status (§18.AG) ───────────────────────────────────────

test('agenda: COMPLETED/NO_SHOW/CANCELED → harvest con la asistencia mapeada', () => {
  assert.deepEqual(decideFromAgenda({ agendaStatus: 'COMPLETED' }), { action: 'harvest', asistencia: 'show' });
  assert.deepEqual(decideFromAgenda({ agendaStatus: 'NO_SHOW' }), { action: 'harvest', asistencia: 'no_show' });
  assert.deepEqual(decideFromAgenda({ agendaStatus: 'CANCELED' }), { action: 'harvest', asistencia: 'cancelado' });
  // El mapa expuesto no incluye estados que no son cosecha directa.
  assert.equal(AGENDA_TO_ASISTENCIA.RESCHEDULED, undefined);
  assert.equal(AGENDA_TO_ASISTENCIA.SCHEDULED, undefined);
});

test('agenda: normaliza mayúsculas/espacios y valores desconocidos → ask', () => {
  assert.equal(decideFromAgenda({ agendaStatus: ' completed ' }).action, 'harvest');
  assert.deepEqual(decideFromAgenda({ agendaStatus: 'WHATEVER' }), { action: 'ask', reason: 'unknown_status' });
  assert.deepEqual(decideFromAgenda({ agendaStatus: '' }), { action: 'ask', reason: 'no_agenda_status' });
  assert.deepEqual(decideFromAgenda({ agendaStatus: null }), { action: 'ask', reason: 'no_agenda_status' });
});

test('agenda: RESCHEDULED → reschedule', () => {
  assert.deepEqual(decideFromAgenda({ agendaStatus: 'RESCHEDULED' }), {
    action: 'reschedule',
    asistencia: 'reagendado',
  });
});

test('agenda: SCHEDULED vencida sin cita futura → nudge', () => {
  assert.deepEqual(decideFromAgenda({ agendaStatus: 'SCHEDULED', now: Date.now() }), { action: 'nudge' });
});

test('agenda: SCHEDULED con cita FUTURA → skip (no molestar)', () => {
  const now = Date.parse('2026-07-17T12:00:00Z');
  const future = '2026-07-21T15:30:00Z';
  assert.deepEqual(decideFromAgenda({ agendaStatus: 'SCHEDULED', nextMeetingStart: future, now }), {
    action: 'skip',
    reason: 'upcoming',
  });
  // Una cita en el PASADO no cuenta como futura → sigue siendo nudge.
  assert.deepEqual(
    decideFromAgenda({ agendaStatus: 'SCHEDULED', nextMeetingStart: '2026-07-10T00:00:00Z', now }),
    { action: 'nudge' }
  );
});

// ─── Guardrail multi-cuenta (§ segunda cuenta de Calendly) ────────────────────

test('isCoveredProgram: un programa de otra cuenta NO se cubre aunque la env lo liste', async () => {
  // HUBSPOT_PROGRAM_PIPELINES es un CSV libre: sin este guardrail, un typo bastaría para
  // apuntar el programa de una agencia al HubSpot de OTRA → le mostraríamos a su closer el
  // deal equivocado y cruzaríamos datos entre clientes. La cuenta manda sobre la env.
  const { ACCOUNTS } = await import('../src/calendly/accounts.js');
  const prev = process.env.HUBSPOT_PROGRAM_PIPELINES;
  ACCOUNTS.__test_agencia = {
    key: '__test_agencia',
    label: 'Agencia de prueba',
    token: () => '',
    orgUri: () => 'https://api.calendly.com/organizations/test',
    eventTypes: { 'https://api.calendly.com/event_types/test-et': 'programa_ajeno' },
    dryRun: () => true,
    push4: () => false,
    hubspot: false, // su CRM NO es el que Juanito tiene conectado
  };
  try {
    process.env.HUBSPOT_PROGRAM_PIPELINES = 'second_brain:904247681,programa_ajeno:999999';
    // Tiene pipeline configurado…
    assert.equal(pipelineForProgram('programa_ajeno'), '999999');
    // …pero igual NO se cubre: su cuenta no vive en este HubSpot → Push 4 clásico.
    assert.equal(isCoveredProgram('programa_ajeno'), false);
    // Y el de la cuenta que sí tiene HubSpot sigue cubierto.
    assert.equal(isCoveredProgram('second_brain'), true);
  } finally {
    delete ACCOUNTS.__test_agencia;
    if (prev === undefined) delete process.env.HUBSPOT_PROGRAM_PIPELINES;
    else process.env.HUBSPOT_PROGRAM_PIPELINES = prev;
  }
});
