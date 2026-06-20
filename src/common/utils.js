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

export function phonesMatch(a, b) {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  // Comparar por igualdad o por sufijo (maneja prefijos de país opcionales)
  return na === nb || na.endsWith(nb) || nb.endsWith(na);
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
