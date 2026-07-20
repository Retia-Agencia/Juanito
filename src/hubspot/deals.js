// src/hubspot/deals.js
// Lógica PURA del modelo nudge (sin red, sin DB → testeable en Windows):
//   - mapa programa (Calendly) → pipeline de deals (HubSpot)
//   - clasificación de la etapa de un deal para decidir si el closer ya registró la call
//
// El fetching (contactos, deals asociados, etapas del pipeline) vive en client.js.
// Solo los 3 programas cuyos deals viven en la cuenta "30x" están cubiertos por el
// modelo nudge; el resto (AI for Developers, IA para Abogados/EstadoX) se queda en el
// Push 4 clásico (preguntar), porque no hay HubSpot al cual apuntar.

import { accountOfProgram } from '../calendly/accounts.js';

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
//
// Doble condición a propósito: además de tener pipeline, el programa tiene que pertenecer a
// una cuenta de Calendly cuyos leads vivan en ESTE HubSpot (`account.hubspot`). El pipeline
// se configura por env (HUBSPOT_PROGRAM_PIPELINES, CSV libre), así que sin este guardrail
// bastaría un typo para apuntar el programa de una agencia al CRM de otra: le mostraríamos
// a su closer el deal equivocado y cruzaríamos datos entre clientes. Un programa de una
// cuenta sin HubSpot cae al Push 4 clásico (preguntar), que es el comportamiento correcto.
export function isCoveredProgram(programKey) {
  if (!pipelineForProgram(programKey)) return false;
  return Boolean(accountOfProgram(programKey)?.hubspot);
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

// ¿La etapa actual del deal es el cierre GANADO? Distinta de `classifyDealStage`: esa
// solo dice si la call ya se registró (cualquier etapa pasado Agendado); esto ubica
// específicamente el cierre exitoso, por label (tolerante a acentos/mayúsculas — labels
// reales como "Ganado Pagado Completo" varían por pipeline) + `isClosed` para no confundir
// con una etapa abierta que mencione "ganado" de pasada.
export function isWonStage(dealStageId, stages = []) {
  if (!dealStageId || !stages.length) return false;
  const byId = new Map(stages.map((s) => [String(s.stageId), s]));
  const cur = byId.get(String(dealStageId));
  if (!cur) return false;
  return Boolean(cur.isClosed) && normalizeLabel(cur.label).includes('ganado');
}

function normalizeLabel(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita acentos por si el label los trae
    .trim()
    .toLowerCase();
}

// ─── Cosecha por `agenda_status` (§18.AG) ─────────────────────────────────────
// El deal trae un campo `agenda_status` (enum) hecho a propósito que encodea DIRECTO el
// estado de la call — incluye el no-show y la reagenda, que la ETAPA del deal no distingue.
// Valores internos (HubSpot) → asistencia de call_outcomes. La venta (Ganado/Perdido) es un
// eje aparte que sigue viniendo de la etapa; acá solo va la ASISTENCIA.
export const AGENDA_TO_ASISTENCIA = {
  COMPLETED: 'show', // Terminada  → asistió
  NO_SHOW: 'no_show', // No asistió
  CANCELED: 'cancelado', // Cancelada
};

// Traduce el `agenda_status` de un deal en una acción para el motor del Push 4. Puro.
//   { action:'harvest', asistencia } → registrar el outcome sin preguntar (COMPLETED/NO_SHOW/CANCELED)
//   { action:'reschedule' }          → reagenda: cosechar 'reagendado' + agendar la call nueva
//   { action:'skip', reason:'upcoming' } → sigue Programada pero hay una cita FUTURA → no molestar
//   { action:'nudge' }               → Programada y la call ya venció, sin cita futura → picar al closer
//   { action:'ask', reason }         → sin estado / valor desconocido → cae a Push 4 clásico (red de seguridad)
export function decideFromAgenda({ agendaStatus, nextMeetingStart, now = Date.now() } = {}) {
  const s = String(agendaStatus || '').trim().toUpperCase();
  if (!s) return { action: 'ask', reason: 'no_agenda_status' };
  if (Object.prototype.hasOwnProperty.call(AGENDA_TO_ASISTENCIA, s)) {
    return { action: 'harvest', asistencia: AGENDA_TO_ASISTENCIA[s] };
  }
  if (s === 'RESCHEDULED') return { action: 'reschedule', asistencia: 'reagendado' };
  if (s === 'SCHEDULED') {
    // "Programada" tras vencer la call es ambiguo: o el closer no cerró el estado (→ nudge),
    // o hay una cita nueva futura (reagenda sin marcar / segunda call → no molestar).
    const nextMs = Date.parse(nextMeetingStart || '');
    if (nextMs && nextMs > now) return { action: 'skip', reason: 'upcoming' };
    return { action: 'nudge' };
  }
  return { action: 'ask', reason: 'unknown_status' };
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
