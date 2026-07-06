// src/whatsapp/cloud-api.js
// Adaptador de la WhatsApp Business Cloud API OFICIAL vía Twilio (§18.AD). Es el canal
// del SETTEO a leads que no agendaron: sale por un número WABA DEDICADO, con plantillas
// pre-aprobadas por Meta → cero riesgo de ban. NO tiene nada que ver con Baileys ni con
// la cola de send-queue del socket principal (un número en Cloud API no puede correr en
// la app/Baileys a la vez). Aislado a propósito para poder cambiar de BSP sin tocar el
// resto del bot.
//
// Módulo PURO respecto a env/red: credenciales y `fetch` se inyectan → testeable con un
// fetch falso. Reusa el módulo puro createSendQueue para un pacing cortés (la Cloud API
// aguanta mucho más que Baileys, pero mantenemos la disciplina de no ametrallar).

import { createSendQueue } from './send-queue.js';

const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const waAddr = (num) => `whatsapp:+${onlyDigits(num)}`;

/**
 * @param {object} opts
 * @param {string} opts.accountSid   TWILIO_ACCOUNT_SID
 * @param {string} opts.authToken    TWILIO_AUTH_TOKEN
 * @param {string} opts.from         número WABA dedicado (dígitos; se envía como whatsapp:+…)
 * @param {function} [opts.fetchImpl] fetch inyectable (default global fetch)
 * @param {number} [opts.minGapMs]   gap global del pacing (default 1000)
 * @param {number} [opts.jitterMs]   jitter del pacing (default 500)
 * @param {number} [opts.maxQueue]   tope de cola (default 500)
 */
export function createCloudApiSender({
  accountSid,
  authToken,
  from,
  fetchImpl,
  minGapMs = 1000,
  jitterMs = 500,
  maxQueue = 500,
} = {}) {
  if (!accountSid || !authToken || !from) {
    throw new Error('[cloud-api] faltan credenciales Twilio (accountSid/authToken/from)');
  }
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) throw new Error('[cloud-api] no hay fetch disponible');

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const queue = createSendQueue({ minGapMs, jitterMs, maxQueue });

  async function post(params) {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`[cloud-api] Twilio ${res.status}: ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  return {
    /**
     * Envía una PLANTILLA aprobada (único envío válido fuera de la ventana de 24h).
     * @param {object} p
     * @param {string} p.to         teléfono del lead (dígitos, con código país)
     * @param {string} p.contentSid Content SID de la plantilla en Twilio
     * @param {object} [p.vars]     variables { "1": "Nombre", … }
     * @returns {Promise<object>} respuesta de Twilio (incluye `sid`, `status`)
     */
    sendTemplate({ to, contentSid, vars = {} }) {
      return queue.enqueue(() =>
        post({
          To: waAddr(to),
          From: waAddr(from),
          ContentSid: contentSid,
          ContentVariables: JSON.stringify(vars || {}),
        })
      );
    },

    /**
     * Texto libre — SOLO válido dentro de la ventana de 24h tras un mensaje del lead.
     * No se usa en la Fase 1 (el inbound se atiende en el inbox de Twilio); queda listo
     * para cuando se automatice la conversación.
     */
    sendText({ to, body }) {
      return queue.enqueue(() =>
        post({ To: waAddr(to), From: waAddr(from), Body: body })
      );
    },

    pending() {
      return queue.size();
    },
  };
}
