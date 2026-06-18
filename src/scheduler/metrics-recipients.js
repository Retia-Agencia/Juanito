// src/scheduler/metrics-recipients.js
// PURO (solo depende de roles.js). Resuelve la lista de destinatarios del reporte de
// métricas (§18.N) desde SHEETS_METRICS_RECIPIENTS. Vive aparte del job para poder
// testearlo sin arrastrar la cola de WhatsApp / better-sqlite3.
//
// SHEETS_METRICS_RECIPIENTS = CSV de teléfonos/JIDs/LIDs. El token literal "boss" se
// resuelve al destino del jefe (BOSS_LID/BOSS_PHONE) en runtime. Sebastián Rodríguez
// va con su contact_jid (LID) capturado por su opt-in de Calendly.

import { bossDmTarget } from '../common/roles.js';

export function resolveRecipients() {
  const raw = (process.env.SHEETS_METRICS_RECIPIENTS || '').trim();
  if (!raw) return [];
  const out = [];
  for (const tokenRaw of raw.split(',')) {
    const token = tokenRaw.trim();
    if (!token) continue;
    const resolved = token.toLowerCase() === 'boss' ? bossDmTarget() : token;
    if (resolved) out.push(resolved);
  }
  // Sin duplicados (un mismo destino no recibe dos veces).
  return [...new Set(out)];
}
