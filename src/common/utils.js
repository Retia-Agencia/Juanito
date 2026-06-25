// src/common/utils.js
// Utilidades compartidas: normalización de números y verificación de firmas

import crypto from 'crypto';

// ─── Normalizar número de teléfono ────────────────────────────────────────────
// Meta y OpenWA pueden mandar el número con +, espacios, guiones, o sufijos.
// Reducimos todo a solo dígitos para comparar de forma robusta.

export function normalizePhone(raw) {
  if (!raw) return '';
  // Quitar sufijos de WhatsApp tipo @c.us / @s.whatsapp.net
  const withoutSuffix = String(raw).split('@')[0];
  // Quedarnos solo con dígitos
  return withoutSuffix.replace(/\D/g, '');
}

// Sanity-check de un teléfono DICTADO por el jefe: lo reduce a dígitos y verifica un largo
// plausible (7–15, el rango de E.164). NO comprueba que el número exista ni a quién pertenece;
// solo atrapa errores GRUESOS de transcripción (dígitos de más/de menos). La defensa principal
// contra "confundir números" es ECHARLO de vuelta al jefe para que lo confirme antes de enviar
// (ver schedule_outreach). Devuelve { ok, digits, reason }. §18 1A.
export function validatePhone(raw) {
  const digits = normalizePhone(raw);
  if (!digits) return { ok: false, digits: '', reason: 'vacío' };
  if (digits.length < 7) return { ok: false, digits, reason: 'muy corto' };
  if (digits.length > 15) return { ok: false, digits, reason: 'muy largo' };
  return { ok: true, digits, reason: null };
}

export function phonesMatch(a, b) {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  // Comparar por igualdad o por sufijo (maneja prefijos de país opcionales)
  return na === nb || na.endsWith(nb) || nb.endsWith(na);
}

// ─── Enmascarar JID/LID/número para logs ──────────────────────────────────────
// Evita derramar PII (números o LIDs completos) en logs que puedan centralizarse.
// Conserva el sufijo (@lid / @s.whatsapp.net) para distinguir tipo, y los últimos 4
// dígitos del cuerpo para poder correlacionar sin exponer la identidad completa.
//   '573105643297@s.whatsapp.net' -> '…3297@s.whatsapp.net'
//   '144268136038585@lid'         -> '…8585@lid'
export function maskJid(raw) {
  if (!raw) return '';
  const s = String(raw);
  const at = s.indexOf('@');
  const local = at >= 0 ? s.slice(0, at) : s;
  const suffix = at >= 0 ? s.slice(at) : '';
  return `…${local.slice(-4)}${suffix}`;
}

// ─── Ventana de descanso / sueño (quiet hours) ────────────────────────────────
// Cuando las aprobaciones están ON, Juanito NO molesta al jefe con solicitudes de
// aprobación dentro de esta ventana: quedan en cola y se le informan al volver el
// horario laboral. Configurable por env (HH:MM en la TZ del bot). Si falta alguna,
// la función devuelve false (sin ventana = comportamiento de siempre).
//   QUIET_HOURS_START=21:00  QUIET_HOURS_END=07:00
// Maneja el cruce de medianoche (start > end).

function parseHm(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export function isWithinQuietHours(now = new Date()) {
  const start = parseHm(process.env.QUIET_HOURS_START);
  const end = parseHm(process.env.QUIET_HOURS_END);
  if (start == null || end == null) return false;
  if (start === end) return false; // ventana nula

  // Minutos del día en la zona horaria del bot (Alpine sin tzdata: usamos toLocaleString).
  const tz = process.env.TZ || 'America/Bogota';
  const parts = new Date(now).toLocaleString('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const local = parseHm(parts.replace(/[^\d:]/g, '').slice(0, 5)) ?? 0;

  // Sin cruce de medianoche: [start, end). Con cruce (start>end): [start, 24h) ∪ [0, end).
  return start < end ? local >= start && local < end : local >= start || local < end;
}

// ─── Mensaje citado (reply nativo de WhatsApp) ────────────────────────────────
// Extrae el TEXTO del mensaje al que el remitente respondió (reply/cita). WhatsApp lo
// guarda en `contextInfo.quotedMessage`, anidado dentro del tipo del mensaje entrante
// (texto, caption de imagen/video, etc.). PURO (recibe `msg.message`, sin Baileys) para
// poder testearlo. Devuelve el texto citado o null si el mensaje no es un reply.
//
// El texto citado puede vivir en varias formas según el tipo del mensaje original:
// conversation (texto simple), extendedTextMessage.text (texto con formato/links),
// o el caption de un media. Cubrimos las comunes; el resto devuelve null sin romper.
export function extractQuotedText(message) {
  if (!message || typeof message !== 'object') return null;
  // contextInfo viaja dentro del tipo concreto del mensaje entrante. El reply de texto
  // es el caso central, pero un reply puede llegar como caption de un media también.
  const ctx =
    message.extendedTextMessage?.contextInfo ||
    message.imageMessage?.contextInfo ||
    message.videoMessage?.contextInfo ||
    message.documentMessage?.contextInfo ||
    null;
  const q = ctx?.quotedMessage;
  if (!q) return null;
  const text =
    q.conversation ||
    q.extendedTextMessage?.text ||
    q.imageMessage?.caption ||
    q.videoMessage?.caption ||
    q.documentMessage?.caption ||
    null;
  return text ? String(text) : null;
}

// ─── Tarjetas de contacto compartidas (vCard) ─────────────────────────────────
// Cuando el jefe COMPARTE un contacto de WhatsApp (en vez de dictar el número), llega como
// un contactMessage/contactsArrayMessage con un vCard crudo. Leer el número de ahí elimina el
// riesgo de transcripción ("los números son sagrados", §18 1A): el número viene EXACTO de la
// tarjeta. PUROS (sin Baileys) para testear.

// Parsea un vCard crudo → { name, phones }. Prefiere `waid=` (el WhatsApp ID: dígitos ya
// canónicos y garantizados con WhatsApp); si no hay waid, normaliza el valor del campo TEL.
export function parseVcard(vcard) {
  const raw = String(vcard || '');
  if (!raw) return { name: null, phones: [] };
  const fn = raw.match(/^FN:(.+)$/im);
  const name = fn ? fn[1].trim() : null;
  const phones = [];
  const telRe = /^TEL[^:\n]*:(.+)$/gim;
  let m;
  while ((m = telRe.exec(raw)) !== null) {
    const waid = m[0].match(/waid=(\d+)/i);
    const digits = waid ? waid[1] : normalizePhone(m[1]);
    if (digits) phones.push(digits);
  }
  return { name, phones: [...new Set(phones)] };
}

// Extrae los contactos compartidos de un msg.message de Baileys (uno o varios). Devuelve
// [{ name, phone, phones }] (phone = el primero/mejor). [] si el mensaje no comparte contactos.
export function extractSharedContacts(message) {
  if (!message || typeof message !== 'object') return [];
  const items = [];
  if (message.contactMessage) items.push(message.contactMessage);
  const arr = message.contactsArrayMessage?.contacts;
  if (Array.isArray(arr)) items.push(...arr);
  const out = [];
  for (const c of items) {
    const parsed = parseVcard(c?.vcard);
    const phone = parsed.phones[0] || null;
    if (phone) out.push({ name: c?.displayName || parsed.name || null, phone, phones: parsed.phones });
  }
  return out;
}

// Texto sintético legible de los contactos compartidos, para inyectarlo en la conversación
// (un contactMessage no trae texto). Marca el número como CONFIABLE (no dictado) para que el
// modelo lo use directo sin pedir confirmar dígitos. null si no hay contactos.
export function describeSharedContacts(contacts) {
  if (!contacts || !contacts.length) return null;
  const parts = contacts.map((c) => {
    const name = c.name || 'sin nombre';
    const nums = (c.phones && c.phones.length ? c.phones : [c.phone]).map((p) => `+${p}`).join(' / ');
    return `"${name}" · ${nums}`;
  });
  const head =
    contacts.length === 1
      ? '[El usuario compartió una tarjeta de contacto de WhatsApp'
      : `[El usuario compartió ${contacts.length} tarjetas de contacto de WhatsApp`;
  return `${head} — datos CONFIABLES tomados de la tarjeta, no dictados]: ${parts.join('; ')}`;
}

// ─── Verificar firma HMAC de un webhook ───────────────────────────────────────
// OpenWA firma el payload con HMAC-SHA256 usando el secret configurado.

export function verifyHmacSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  try {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');
    // Comparación en tiempo constante para evitar timing attacks
    const sigBuf = Buffer.from(signature.replace(/^sha256=/, ''), 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch (e) {
    return false;
  }
}
