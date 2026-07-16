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
