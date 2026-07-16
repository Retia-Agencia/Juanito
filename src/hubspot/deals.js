// src/hubspot/deals.js
// Lógica PURA del modelo nudge (sin red, sin DB → testeable en Windows):
//   - mapa programa (Calendly) → pipeline de deals (HubSpot)
//   - clasificación de la etapa de un deal para decidir si el closer ya registró la call
//
// El fetching (contactos, deals asociados, etapas del pipeline) vive en client.js.
// Solo los 3 programas cuyos deals viven en la cuenta "30x" están cubiertos por el
// modelo nudge; el resto (AI for Developers, IA para Abogados/EstadoX) se queda en el
// Push 4 clásico (preguntar), porque no hay HubSpot al cual apuntar.

// programKey (de src/calendly/index.js) → pipelineId de deals. Override por env:
//   HUBSPOT_PROGRAM_PIPELINES="second_brain:904247681,linkedin:906259304,operaciones:887379063"
const DEFAULT_PROGRAM_PIPELINES = {
  second_brain: '904247681',
  linkedin: '906259304',
  operaciones: '887379063',
};

export function programPipelines() {
  const raw = process.env.HUBSPOT_PROGRAM_PIPELINES;
  if (!raw) return { ...DEFAULT_PROGRAM_PIPELINES };
  const out = {};
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split(':').map((s) => s && s.trim());
    if (k && v) out[k] = v;
  }
  return out;
}

// pipelineId del programa, o null si el programa no está cubierto (→ Push 4 clásico).
export function pipelineForProgram(programKey) {
  return programPipelines()[programKey] || null;
}

// ¿El programa se gestiona por el modelo nudge (tiene pipeline en esta cuenta)?
export function isCoveredProgram(programKey) {
  return Boolean(pipelineForProgram(programKey));
}

// Clasifica la etapa actual de un deal, dado el detalle de etapas del pipeline.
// `stages` = [{ stageId, label, displayOrder, isClosed }] (de getPipelineStages).
// Devuelve:
//   'resolved' → el closer ya avanzó el deal (Atendido o más allá, o cerrado) → callar
//   'stale'    → sigue en Agendado (o antes) tras pasar la call → NUDGE
//   'unknown'  → no se pudo ubicar la etapa / el pipeline no tiene "Agendado"
export function classifyDealStage(dealStageId, stages = []) {
  if (!dealStageId || !stages.length) return 'unknown';
  const byId = new Map(stages.map((s) => [String(s.stageId), s]));
  const cur = byId.get(String(dealStageId));
  if (!cur) return 'unknown';

  // La etapa "Agendado" es el umbral: en ella la call está agendada pero aún no
  // registrada como atendida. La ubicamos por label (tolerante a acentos/mayúsculas).
  const agendado = stages.find((s) => normalizeLabel(s.label) === 'agendado');
  if (!agendado) return 'unknown';

  if (cur.isClosed) return 'resolved';
  return cur.displayOrder > agendado.displayOrder ? 'resolved' : 'stale';
}

function normalizeLabel(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita acentos por si el label los trae
    .trim()
    .toLowerCase();
}

// De una lista de deals de un contacto, elige el más relevante para el pipeline dado:
// el del pipeline correcto, y entre varios, el modificado más recientemente.
export function pickDealForPipeline(deals = [], pipelineId) {
  const inPipe = deals.filter((d) => String(d.properties?.pipeline) === String(pipelineId));
  if (!inPipe.length) return null;
  return inPipe.sort((a, b) => {
    const ta = Date.parse(a.properties?.hs_lastmodifieddate || 0) || 0;
    const tb = Date.parse(b.properties?.hs_lastmodifieddate || 0) || 0;
    return tb - ta;
  })[0];
}
