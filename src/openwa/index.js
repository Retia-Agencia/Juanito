// src/openwa/index.js
// Lectura de chats y grupos del número del jefe via OpenWA REST API

import axios from 'axios';

function client() {
  return axios.create({
    baseURL: process.env.OPENWA_URL,
    headers: { 'X-API-Key': process.env.OPENWA_API_KEY },
    timeout: 10000,
  });
}

const SESSION = () => process.env.OPENWA_SESSION_ID;

// ─── Registrar webhook en OpenWA ──────────────────────────────────────────────
// Llama esto al arrancar para que OpenWA nos avise de mensajes nuevos

export async function registerWebhook(callbackUrl) {
  try {
    const res = await client().post(
      `/sessions/${SESSION()}/webhooks`,
      {
        url: callbackUrl,
        events: ['message.received'],
        secret: process.env.META_VERIFY_TOKEN, // reutilizamos el mismo token
      }
    );
    console.log('[OpenWA] Webhook registrado:', res.data);
    return res.data;
  } catch (err) {
    console.error('[OpenWA] Error registrando webhook:', err.response?.data || err.message);
  }
}

// ─── Obtener mensajes recientes de un chat/grupo ───────────────────────────────

export async function getRecentMessages(chatId, limit = 30) {
  try {
    const res = await client().get(
      `/sessions/${SESSION()}/messages`,
      { params: { chatId, limit } }
    );
    return res.data?.data || [];
  } catch (err) {
    console.error('[OpenWA] Error obteniendo mensajes:', err.response?.data || err.message);
    return [];
  }
}

// ─── Listar grupos donde está el jefe ────────────────────────────────────────

export async function listGroups() {
  try {
    const res = await client().get(`/sessions/${SESSION()}/groups`);
    return res.data?.data || [];
  } catch (err) {
    console.error('[OpenWA] Error listando grupos:', err.response?.data || err.message);
    return [];
  }
}

// ─── Resolver un grupo por nombre ─────────────────────────────────────────────
// Busca sobre la lista de grupos del jefe: primero coincidencia exacta, luego
// parcial (case-insensitive). Alimenta la herramienta summarize_group.
// `groups` es inyectable para tests; por defecto se piden a OpenWA.

export async function resolveGroupByName(name, groups) {
  if (!name) return null;
  const list = groups || (await listGroups());
  const q = name.trim().toLowerCase();
  return (
    list.find((g) => (g.name || '').toLowerCase() === q) ||
    list.find((g) => (g.name || '').toLowerCase().includes(q)) ||
    null
  );
}

// ─── Parsear mensaje entrante del webhook de OpenWA ───────────────────────────

export function parseOpenWAMessage(body) {
  try {
    const { event, data } = body;
    if (event !== 'message.received') return null;

    const chatId = data?.message?.chatId || data?.chatId;
    const isGroup = chatId?.endsWith('@g.us');
    const text = data?.message?.body || data?.body || null;
    const sender = data?.message?.sender?.id || data?.sender || null;
    const groupName = data?.chat?.name || chatId;

    return { chatId, isGroup, text, sender, groupName, raw: data };
  } catch (e) {
    console.error('[OpenWA] Error parseando mensaje:', e.message);
    return null;
  }
}

// ─── Verificar que la sesión esté activa ─────────────────────────────────────

export async function checkSession() {
  try {
    const res = await client().get(`/sessions/${SESSION()}`);
    const status = res.data?.status;
    console.log('[OpenWA] Estado de sesión:', status);
    return status === 'CONNECTED' || status === 'ready';
  } catch (err) {
    console.error('[OpenWA] Sesión no disponible:', err.message);
    return false;
  }
}
