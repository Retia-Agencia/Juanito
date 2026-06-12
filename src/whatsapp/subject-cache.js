// src/whatsapp/subject-cache.js
// TTL-cache mínimo para el subject (nombre) de los grupos (§18.D P1-b del handoff).
//
// Por qué existe: messages.upsert llamaba `await sock.groupMetadata(chatId)` por CADA
// mensaje de grupo solo para sacar el nombre — un valor constante. A 200 msg/min son
// 200 awaits/min de gusto en el hot path. Con este cache, el metadata se pide una vez
// y se refresca por TTL o cuando cambian los participantes/subject.
//
// Módulo PURO: reloj inyectable, sin Baileys. Testeable nativo en Windows.

/**
 * @param {object} opts
 * @param {number} opts.ttlMs          vida de una entrada exitosa (default 10 min)
 * @param {number} opts.negativeTtlMs  vida de una entrada fallback/fallida (default 60 s)
 * @param {function} [opts.now]        () => epoch ms — inyectable para tests
 */
export function createTtlCache({ ttlMs, negativeTtlMs, now } = {}) {
  const ttl = Number.isFinite(ttlMs) ? ttlMs : 10 * 60 * 1000;
  const negTtl = Number.isFinite(negativeTtlMs) ? negativeTtlMs : 60 * 1000;
  const clock = now || Date.now;

  const entries = new Map(); // key → { value, expiresAt }

  return {
    /** Devuelve el valor si existe y no expiró; si no, undefined. */
    get(key) {
      const e = entries.get(key);
      if (!e) return undefined;
      if (clock() >= e.expiresAt) {
        entries.delete(key);
        return undefined;
      }
      return e.value;
    },
    /** Guarda con TTL normal; `negative: true` usa el TTL corto (fallback de error). */
    set(key, value, { negative = false } = {}) {
      entries.set(key, { value, expiresAt: clock() + (negative ? negTtl : ttl) });
    },
    delete(key) {
      entries.delete(key);
    },
    size() {
      return entries.size;
    },
  };
}
