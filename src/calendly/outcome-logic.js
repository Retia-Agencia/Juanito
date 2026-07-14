// src/calendly/outcome-logic.js
// PURO (solo importa los parsers; sin DB ni WhatsApp → testeable en Windows). Decide qué
// hacer con la respuesta del closer a un Push 4 (§18.AB), dado el outcome pendiente y el
// texto. outcome-capture.js ejecuta la decisión (DB + WA).
//
// Tres pasos posibles:
//   asistencia → resultado   (si fue Show)
//   asistencia → fecha       (si Reagendó, §18.AC — así la call nueva sí entra a métricas)

import { parseAsistenciaReply, parseResultadoReply } from './index.js';
import { parseRescheduleReply } from './reschedule-parse.js';

// Devuelve una de:
//   { kind: 'reprompt', step: 'asistencia'|'resultado' }   → no entendí, re-preguntar
//   { kind: 'asistencia', asistencia, followup: 'resultado'|'fecha'|'confirm' }
//   { kind: 'resultado', resultado }
//   { kind: 'reschedule', startUtc }        → reagendó y dio la fecha
//   { kind: 'reschedule_unknown' }          → reagendó pero aún no hay fecha
//   { kind: 'reschedule_reprompt', reason } → no entendí la fecha ('past'|'far'|undefined)
export function decideOutcomeReply(outcome, text, { nowMs = Date.now(), tz } = {}) {
  // Paso 3: reagendó, falta la fecha de la call nueva.
  if (outcome?.status === 'awaiting_date') {
    const r = parseRescheduleReply(text, { nowMs, ...(tz ? { tz } : {}) });
    if (r.kind === 'datetime') return { kind: 'reschedule', startUtc: r.startUtc };
    if (r.kind === 'unknown_date') return { kind: 'reschedule_unknown' };
    // 'invalid' (fecha pasada / delirante) y 'none' → repreguntar. El fallback de IA para
    // el caso 'none' lo intenta outcome-capture ANTES de mandar esta repregunta.
    return { kind: 'reschedule_reprompt', reason: r.reason };
  }

  // Paso 1: falta la asistencia.
  if (!outcome || !outcome.asistencia) {
    const asistencia = parseAsistenciaReply(text);
    if (!asistencia) return { kind: 'reprompt', step: 'asistencia' };
    const followup =
      asistencia === 'show' ? 'resultado' : asistencia === 'reagendado' ? 'fecha' : 'confirm';
    return { kind: 'asistencia', asistencia, followup };
  }

  // Paso 2: asistencia = show, falta el resultado.
  const resultado = parseResultadoReply(text);
  if (!resultado) return { kind: 'reprompt', step: 'resultado' };
  return { kind: 'resultado', resultado };
}
