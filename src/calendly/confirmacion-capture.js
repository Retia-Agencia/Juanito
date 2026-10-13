// src/calendly/confirmacion-capture.js
// Captura la respuesta del closer a la pregunta de confirmación del Push 2 (§18.CN).
//
// Se invoca desde src/index.js ANTES de captureOutcomeReply: "1 3" es una respuesta válida a las
// dos preguntas, así que gana la que se hizo más reciente. Si el closer tiene un Push 4 abierto
// preguntado DESPUÉS de la confirmación, este módulo no consume y el mensaje sigue al outcome.
//
// Solo consume si el closer tiene un lote abierto. Después de la primera respuesta, solo toma
// correcciones inequívocas ("el 2 canceló"), para no tragarse el resto de la conversación del día.

import { resolveCloserByPhone, resolveCloserByLid, resolveCloserByPushName } from './closers.js';
import {
  getActiveOutcomeForCloser,
  getLoteConfirmacionAbierto,
  setConfirmacionEstados,
  markConfirmacionReprompt,
  markIfNew,
} from '../db/index.js';
import {
  parseConfirmacion,
  resolverConfirmacion,
  esCorreccionClara,
  buildConfirmacionResumen,
  CONFIRMACION_REPROMPT,
} from './confirmacion-logic.js';
import { sendMessage } from '../whatsapp/index.js';

function resolveCloser(from, pushName) {
  return (
    resolveCloserByPhone(from) ||
    resolveCloserByLid(from) ||
    (pushName ? resolveCloserByPushName(pushName) : null)
  );
}

// SQLite guarda 'YYYY-MM-DD HH:MM:SS' en UTC.
const ms = (v) => (v ? Date.parse(`${String(v).replace(' ', 'T')}Z`) : NaN);

// Devuelve true si el mensaje era la respuesta a la confirmación (y lo manejó).
export async function captureConfirmacionReply({ from, pushName, text, messageId }) {
  const closer = resolveCloser(from, pushName);
  if (!closer) return false;

  const filas = getLoteConfirmacionAbierto(closer.phone);
  if (!filas.length) return false;

  // Un Push 4 preguntado después de la confirmación es lo que el closer está contestando.
  const outcome = getActiveOutcomeForCloser(closer.phone);
  const preguntada = ms(filas[0].preguntada_at);
  if (outcome && ms(outcome.prompted_at || outcome.asked_at) > preguntada) return false;

  const n = filas.length;
  const primera = filas.every((f) => !f.answered_at);
  const parsed = parseConfirmacion(text, n);
  if (!primera && !esCorreccionClara(parsed)) return false;

  if (messageId && !markIfNew(messageId)) return true;
  const lote = filas[0].lote;

  if (parsed.kind === 'unknown') {
    // Una sola repregunta: si tampoco se entiende, el mensaje sigue al resto de los flujos.
    if (filas[0].reprompted) return false;
    markConfirmacionReprompt(lote);
    await sendMessage(from, CONFIRMACION_REPROMPT);
    return true;
  }

  const cambios = resolverConfirmacion(parsed, n, { primera });
  setConfirmacionEstados(lote, cambios, text);
  const estados = Object.fromEntries(filas.map((f) => [f.posicion, cambios[f.posicion] || f.estado]));
  console.log(
    `[Calendly] confirmación ${lote}: ` +
      Object.entries(estados).map(([p, e]) => `${p}=${e}`).join(' ') +
      (primera ? '' : ' (corrección)')
  );
  await sendMessage(from, buildConfirmacionResumen({ items: filas.map((f) => ({ name: f.lead_name })), estados }));
  return true;
}
