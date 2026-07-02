// src/calendly/outcome-logic.js
// PURO (solo importa los parsers de ./index.js; sin DB ni WhatsApp → testeable en
// Windows). Decide qué hacer con la respuesta del closer a un Push 4 (§18.AB), dado
// el outcome pendiente y el texto. outcome-capture.js ejecuta la decisión (DB + WA).

import { parseAsistenciaReply, parseResultadoReply } from './index.js';

// Devuelve una de:
//   { kind: 'reprompt', step: 'asistencia'|'resultado' }  → no entendí, re-preguntar
//   { kind: 'asistencia', asistencia, followup: 'resultado'|'confirm' }
//   { kind: 'resultado', resultado }
export function decideOutcomeReply(outcome, text) {
  // Paso 1: falta la asistencia.
  if (!outcome || !outcome.asistencia) {
    const asistencia = parseAsistenciaReply(text);
    if (!asistencia) return { kind: 'reprompt', step: 'asistencia' };
    // Show → seguimos al resultado; cualquier otro estado cierra el outcome.
    return { kind: 'asistencia', asistencia, followup: asistencia === 'show' ? 'resultado' : 'confirm' };
  }
  // Paso 2: asistencia = show, falta el resultado.
  const resultado = parseResultadoReply(text);
  if (!resultado) return { kind: 'reprompt', step: 'resultado' };
  return { kind: 'resultado', resultado };
}
