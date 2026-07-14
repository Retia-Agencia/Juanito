// src/calendly/outcome-capture.js
// Captura la respuesta del closer a un Push 4 (§18.AB) y la guarda en call_outcomes.
//
// Se invoca desde src/index.js para DMs que NO son del jefe, ANTES de handleCloserOptin
// (que devuelve true para cualquier mensaje de un closer conocido y se tragaría la
// respuesta). Solo consume el mensaje si ese closer tiene un outcome ABIERTO; si no,
// devuelve false y el flujo normal (opt-in / asistente) sigue igual.
//
// Flujo: asistencia (siempre) → resultado (si fue Show) → fecha (si Reagendó, §18.AC).
// Respuesta por número o lenguaje natural; si no se entiende, re-pregunta sin quemar nada.

import { resolveCloserByPhone, resolveCloserByLid, resolveCloserByPushName } from './closers.js';
import {
  getActiveOutcomeForCloser,
  setOutcomeAsistencia,
  setOutcomeResultado,
  setOutcomeReschedule,
  markIfNew,
} from '../db/index.js';
import {
  buildOutcomeFollowupMessage,
  buildOutcomeConfirmation,
  buildRescheduleAskMessage,
  buildRescheduleConfirmation,
  buildRescheduleSinFechaMessage,
  buildRescheduleReprompt,
  fullNameFrom,
  toSqliteUtc,
} from './index.js';
import { decideOutcomeReply } from './outcome-logic.js';
import { parseRescheduleWithAi } from './reschedule-ai.js';
import { createRescheduledCall } from './reschedule.js';
import { sendMessage } from '../whatsapp/index.js';

const RESCHEDULE_ENABLED = () => process.env.CALENDLY_RESCHEDULE_ENABLED === 'true';
const AI_FALLBACK = () => process.env.CALENDLY_RESCHEDULE_AI !== 'false';

function resolveCloser(from, pushName) {
  return (
    resolveCloserByPhone(from) ||
    resolveCloserByLid(from) ||
    (pushName ? resolveCloserByPushName(pushName) : null)
  );
}

// Agenda la call reagendada y cierra el outcome. Devuelve el mensaje para el closer.
function commitReschedule(outcome, startUtc, rawReply, lead) {
  const r = createRescheduledCall(outcome, startUtc);
  if (!r.ok) {
    // Cadena de reagendas demasiado larga: se registra el movimiento (cuenta como movida
    // en el reporte) pero no se crea otra call — algo pasa con ese lead.
    setOutcomeReschedule(outcome.id, { startUtc: toSqliteUtc(startUtc), uuid: null, rawReply });
    console.warn(`[Calendly] reagenda #${outcome.id}: cadena muy larga (${r.depth}) — no agendo otra call`);
    return `✅ Anotado. Ojo: *${lead}* ya lleva ${r.depth - 1} reagendas — esta no la voy a seguir yo.`;
  }
  setOutcomeReschedule(outcome.id, { startUtc: toSqliteUtc(startUtc), uuid: r.uuid, rawReply });
  console.log(
    `[Calendly] reagenda #${outcome.id} → ${r.uuid} | ${lead} | ${toSqliteUtc(startUtc)} UTC (agendados: ${r.scheduled.join(', ')})`
  );
  return buildRescheduleConfirmation({ name: lead, startIso: new Date(startUtc).toISOString() });
}

// Devuelve true si el mensaje era la respuesta a un outcome abierto (y lo manejó).
export async function captureOutcomeReply({ from, pushName, text, messageId }) {
  const closer = resolveCloser(from, pushName);
  if (!closer) return false;

  const outcome = getActiveOutcomeForCloser(closer.phone);
  if (!outcome) return false; // este closer no tiene nada abierto → no es respuesta de outcome

  // Es una respuesta a un outcome abierto → la consumimos. Dedup del entrante.
  if (messageId && !markIfNew(messageId)) return true;

  const lead = fullNameFrom(outcome.lead_name);
  let decision = decideOutcomeReply(outcome, text);

  // Fallback de IA SOLO para la fecha de una reagenda que el regex no entendió (no para
  // 'past'/'far': ahí sí entendimos, la fecha es la que no sirve).
  if (decision.kind === 'reschedule_reprompt' && !decision.reason && AI_FALLBACK()) {
    const ai = await parseRescheduleWithAi(text);
    if (ai.kind === 'datetime') decision = { kind: 'reschedule', startUtc: ai.startUtc };
    else if (ai.kind === 'unknown_date') decision = { kind: 'reschedule_unknown' };
    else if (ai.kind === 'invalid') decision = { kind: 'reschedule_reprompt', reason: ai.reason };
  }

  let msg;

  switch (decision.kind) {
    case 'reprompt':
      msg =
        decision.step === 'asistencia'
          ? `🙈 No te entendí. ¿Cómo te fue con *${lead}*?\n1️⃣ Show · 2️⃣ No show · 3️⃣ Reagendó`
          : `🙈 No te entendí. ¿Resultado de *${lead}*?\n1️⃣ Venta cerrada · 2️⃣ Acuerdo verbal · 3️⃣ Seguimiento · 4️⃣ No cerró`;
      break;

    case 'asistencia':
      setOutcomeAsistencia(outcome.id, decision.asistencia, text);
      if (decision.followup === 'resultado') {
        msg = buildOutcomeFollowupMessage({ name: lead }); // Show → preguntamos el resultado
      } else if (decision.followup === 'fecha' && RESCHEDULE_ENABLED()) {
        msg = buildRescheduleAskMessage({ name: lead }); // Reagendó → preguntamos la fecha
      } else {
        // No show / cancelado, o reagendas apagadas (rollout) → cierra acá, como antes.
        if (decision.followup === 'fecha') setOutcomeReschedule(outcome.id, { rawReply: text });
        msg = buildOutcomeConfirmation({ name: lead, asistencia: decision.asistencia });
      }
      break;

    case 'resultado':
      setOutcomeResultado(outcome.id, decision.resultado, text);
      msg = buildOutcomeConfirmation({ name: lead, asistencia: 'show', resultado: decision.resultado });
      break;

    case 'reschedule':
      msg = commitReschedule(outcome, decision.startUtc, text, lead);
      break;

    case 'reschedule_unknown':
      // Se queda en 'awaiting_date': el cron diario le vuelve a pedir la fecha.
      msg = buildRescheduleSinFechaMessage({ name: lead });
      break;

    case 'reschedule_reprompt':
      msg = buildRescheduleReprompt({ name: lead, reason: decision.reason });
      break;

    default:
      return true;
  }

  await sendMessage(from, msg).catch(() => {});
  return true;
}
