// src/hubspot/agenda-poll.js
// PURO (sin red, sin DB → testeable en Windows). Decide QUÉ citas de HubSpot merecen pushes
// precall propios: las que Calendly no ve porque se agendaron a mano dentro del CRM.
//
// Por qué existe (2026-07-27): el poll que crea pushes lee SOLO Calendly. Medido en producción,
// de 844 calls con push en 30 días, ninguna venía de HubSpot — y en un día cualquiera hay ~11
// calls que solo existen ahí. Esas calls salían en la agenda del jefe (§18.AN) pero el closer
// nunca recibía aviso. Este módulo cierra ese hueco.
//
// ⚠️ EL RIESGO DE ESTE FEATURE NO ES PERDER UN PUSH, ES MANDAR DOS. Un closer que recibe el
// mismo aviso dos veces pierde confianza en Juanito, y el doble envío es justo el patrón que
// enoja a WhatsApp. Por eso el filtro es de tres capas y todas son de exclusión:
//   1. programa — solo los que viven en el HubSpot conectado (Retia jamás entra acá).
//   2. duplicados DENTRO de HubSpot — el CRM guarda varios registros de una misma call
//      (caso real: 3 meetings al mismo minuto), así que `meeting.id` NO equivale a "una call".
//   3. ya agendado — si esa call ya tiene push (de Calendly o de un ciclo anterior), no se toca.
// Ante la duda, NO se agenda: preferimos un push perdido antes que uno repetido.

import { accountOfProgram } from '../calendly/accounts.js';

// Clave de identidad de una call: closer + minuto de arranque. La MISMA que usa
// `mergeAgendaSources` en meetings.js — deliberado: si las dos capas dedupearan distinto,
// una call podría pasar el filtro del reporte y no el del push (o al revés).
export const callKey = (email, callStart) =>
  `${String(email || '').toLowerCase().trim()}|${String(callStart || '').slice(0, 16)}`;

// ¿Los leads de este programa viven en el HubSpot conectado? Mismo guardrail que
// `isCoveredProgram` en deals.js, pero SIN exigir pipeline: para mandar un push precall no hace
// falta que el programa tenga deals cableados, solo que la cita sea de esta empresa. Un programa
// de otra agencia (Retia) nunca debe recibir pushes derivados de este CRM.
export function programLivesInThisHubspot(programKey) {
  return Boolean(programKey && accountOfProgram(programKey)?.hubspot);
}

// Decide qué citas de HubSpot hay que agendar.
//   `hubspotCalls`  — filas de meetingsToCalls ({ event_uuid, program, closer_email, call_start… })
//   `existingCalls` — filas de getScheduledCallsInWindow (las que YA tienen push)
// Devuelve { toSchedule, skipped: { programa, duplicado, yaAgendado } }.
// El orden importa: se ordena por call_start para que un ciclo parcial siempre empiece por lo
// más próximo, que es lo que más urge avisar.
export function pickMeetingsToSchedule({ hubspotCalls = [], existingCalls = [] } = {}) {
  const yaAgendadas = new Set(existingCalls.map((c) => callKey(c.closer_email, c.call_start)));
  const vistas = new Set();
  const toSchedule = [];
  const skipped = { programa: 0, duplicado: 0, yaAgendado: 0 };

  for (const call of [...hubspotCalls].sort((a, b) => String(a.call_start).localeCompare(b.call_start))) {
    if (!programLivesInThisHubspot(call.program)) {
      skipped.programa++;
      continue;
    }
    const key = callKey(call.closer_email, call.call_start);
    if (yaAgendadas.has(key)) {
      skipped.yaAgendado++;
      continue;
    }
    if (vistas.has(key)) {
      skipped.duplicado++; // otro registro de HubSpot para la MISMA call
      continue;
    }
    vistas.add(key);
    toSchedule.push(call);
  }

  return { toSchedule, skipped };
}

// 'YYYY-MM-DD HH:MM:SS' (UTC, formato de call_start en SQLite) → ISO, que es lo que comen los
// builders de mensaje y `computePush3Schedule`. Devuelve null si no parsea.
export function callStartToIso(callStart) {
  if (!callStart) return null;
  const iso = `${String(callStart).trim().replace(' ', 'T')}Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}
