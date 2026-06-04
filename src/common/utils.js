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

// ─── Verificar firma de Meta (X-Hub-Signature-256) ────────────────────────────

export function verifyMetaSignature(rawBody, signature, appSecret) {
  if (!signature || !appSecret) return true; // si no hay secret configurado, no bloqueamos
  return verifyHmacSignature(rawBody, signature, appSecret);
}
