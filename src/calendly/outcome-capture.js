// src/calendly/outcome-capture.js
// Captura la respuesta del closer a un Push 4 (§18.AB) y la guarda en call_outcomes.
//
// Se invoca desde src/index.js para DMs que NO son del jefe, ANTES de handleCloserOptin
// (que devuelve true para cualquier mensaje de un closer conocido y se tragaría la
// respuesta). Solo consume el mensaje si ese closer tiene un outcome PENDIENTE; si no,
// devuelve false y el flujo normal (opt-in / asistente) sigue igual.
//
// Flujo de 2 pasos: asistencia (siempre) → resultado (solo si fue Show). Respuesta por
// número o lenguaje natural; si no se entiende, re-pregunta sin quemar nada.

import { resolveCloserByPhone, resolveCloserByLid, resolveCloserByPushName } from './closers.js';
import {
  getActiveOutcomeForCloser,
  setOutcomeAsistencia,
  setOutcomeResultado,
  markIfNew,
} from '../db/index.js';
import { buildOutcomeFollowupMessage, buildOutcomeConfirmation, fullNameFrom } from './index.js';
import { decideOutcomeReply } from './outcome-logic.js';
import { sendMessage } from '../whatsapp/index.js';

function resolveCloser(from, pushName) {
  return (
    resolveCloserByPhone(from) ||
    resolveCloserByLid(from) ||
    (pushName ? resolveCloserByPushName(pushName) : null)
  );
}

// Devuelve true si el mensaje era la respuesta a un outcome pendiente (y lo manejó).
export async function captureOutcomeReply({ from, pushName, text, messageId }) {
  const closer = resolveCloser(from, pushName);
  if (!closer) return false;

  const outcome = getActiveOutcomeForCloser(closer.phone);
  if (!outcome) return false; // este closer no tiene nada pendiente → no es respuesta de outcome

  // Es una respuesta a un outcome pendiente → la consumimos. Dedup del entrante.
  if (messageId && !markIfNew(messageId)) return true;

  const lead = fullNameFrom(outcome.lead_name);
  const decision = decideOutcomeReply(outcome, text);

  if (decision.kind === 'reprompt') {
    const msg =
      decision.step === 'asistencia'
        ? `🙈 No te entendí. ¿Cómo te fue con *${lead}*?\n1️⃣ Show · 2️⃣ No show · 3️⃣ Reagendó`
        : `🙈 No te entendí. ¿Resultado de *${lead}*?\n1️⃣ Venta cerrada · 2️⃣ Acuerdo verbal · 3️⃣ Seguimiento · 4️⃣ No cerró`;
    await sendMessage(from, msg).catch(() => {});
    return true;
  }

  if (decision.kind === 'asistencia') {
    setOutcomeAsistencia(outcome.id, decision.asistencia, text);
    const msg =
      decision.followup === 'resultado'
        ? buildOutcomeFollowupMessage({ name: lead }) // Show → preguntamos el resultado
        : buildOutcomeConfirmation({ name: lead, asistencia: decision.asistencia }); // cierra acá
    await sendMessage(from, msg).catch(() => {});
    return true;
  }

  // decision.kind === 'resultado' → cierra el outcome.
  setOutcomeResultado(outcome.id, decision.resultado, text);
  await sendMessage(
    from,
    buildOutcomeConfirmation({ name: lead, asistencia: 'show', resultado: decision.resultado })
  ).catch(() => {});
  return true;
}
