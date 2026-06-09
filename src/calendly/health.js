// src/calendly/health.js
// Estado de salud + deduplicación de alertas para los jobs de Calendly (decisión 5).
//
// In-memory a propósito: se reinicia con el proceso. Re-alertar tras un reinicio
// es aceptable (incluso útil: confirma que un fallo persistente sigue vivo). No
// necesita DB ni migración, y al no tener deps nativas es importable desde
// commands.js (que evita better-sqlite3 para ser testeable).

const state = {
  lastPollAt: null,       // ms del último poll exitoso
  lastPollCount: null,    // citas vistas en el último poll
  lastError: null,        // texto del último error de Calendly
  lastErrorAt: null,      // ms del último error
  unmapped: new Map(),    // email host sin closer → { count, lastSeen }
};

const alertedAt = new Map(); // dedupKey → ms de la última alerta enviada

export function recordPollOk(count) {
  state.lastPollAt = Date.now();
  state.lastPollCount = count;
}

export function recordPollError(msg) {
  state.lastError = String(msg || '').slice(0, 200);
  state.lastErrorAt = Date.now();
}

export function recordUnmapped(email) {
  if (!email) return;
  const e = state.unmapped.get(email) || { count: 0, lastSeen: 0 };
  e.count += 1;
  e.lastSeen = Date.now();
  state.unmapped.set(email, e);
}

// ¿Pasó el TTL desde la última alerta de esta clave? Si sí, registra y devuelve
// true (evita spamear al admin cada 5 min con el mismo problema).
export function shouldAlert(key, ttlMs = 6 * 3600 * 1000, nowMs = Date.now()) {
  const last = alertedAt.get(key) || 0;
  if (nowMs - last >= ttlMs) {
    alertedAt.set(key, nowMs);
    return true;
  }
  return false;
}

export function getHealth() {
  return {
    lastPollAt: state.lastPollAt,
    lastPollCount: state.lastPollCount,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
    unmapped: [...state.unmapped.entries()].map(([email, v]) => ({ email, ...v })),
  };
}

// Solo para tests.
export function __resetHealth() {
  state.lastPollAt = null;
  state.lastPollCount = null;
  state.lastError = null;
  state.lastErrorAt = null;
  state.unmapped.clear();
  alertedAt.clear();
}
