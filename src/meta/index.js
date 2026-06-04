// src/meta/index.js
// Envío de mensajes via Meta Cloud API + verificación de webhook

import axios from 'axios';

// Versión de Graph API configurable. v19 (2023) está obsoleta; usamos una actual
// por defecto y dejamos override por env para subirla sin tocar código.
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v22.0';
const BASE_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

// ─── Enviar mensaje de texto ──────────────────────────────────────────────────

export async function sendMessage(to, text) {
  try {
    const res = await axios.post(
      `${BASE_URL}/${process.env.META_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.META_WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`[Meta] Mensaje enviado a ${to}`);
    return res.data;
  } catch (err) {
    console.error('[Meta] Error enviando mensaje:', err.response?.data || err.message);
    throw err;
  }
}

// ─── Enviar template de utilidad ──────────────────────────────────────────────
// Necesario para escribirle a alguien FUERA de la ventana de servicio de 24 h
// (p. ej. recordatorios a terceros). El template debe estar aprobado en Meta.
// `components` sigue el formato de la Cloud API, ej:
//   [{ type: 'body', parameters: [{ type: 'text', text: 'call con el equipo' }] }]

export async function sendTemplate(to, templateName, languageCode = 'es', components = []) {
  const template = {
    name: templateName,
    language: { code: languageCode },
  };
  if (components.length) template.components = components;

  try {
    const res = await axios.post(
      `${BASE_URL}/${process.env.META_PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'template', template },
      {
        headers: {
          Authorization: `Bearer ${process.env.META_WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`[Meta] Template "${templateName}" enviado a ${to}`);
    return res.data;
  } catch (err) {
    console.error('[Meta] Error enviando template:', err.response?.data || err.message);
    throw err;
  }
}

// ─── Parsear mensaje entrante del webhook ─────────────────────────────────────

export function parseIncomingMessage(body) {
  try {
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Meta también manda webhooks de 'statuses' (entregado/leído) — no son mensajes
    if (!value?.messages?.length) return null;

    const msg = value.messages[0];
    const contact = value.contacts?.[0];

    // Solo manejamos texto por ahora; otros tipos se ignoran limpiamente
    return {
      from: msg.from,
      name: contact?.profile?.name || msg.from,
      text: msg.text?.body || null,
      type: msg.type,
      messageId: msg.id,
      timestamp: msg.timestamp,
    };
  } catch (e) {
    console.error('[Meta] Error parseando mensaje:', e.message);
    return null;
  }
}

// ─── Verificar webhook de Meta ────────────────────────────────────────────────

export function verifyWebhook(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('[Meta] Webhook verificado ✅');
    return { valid: true, challenge };
  }
  return { valid: false };
}
