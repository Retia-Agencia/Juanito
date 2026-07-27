// src/hubspot/meetings.js
// PURO (sin red, sin DB → testeable en Windows). Traduce los meetings de HubSpot a filas de
// agenda y las UNE con las calls que ya vienen de Calendly.
//
// Por qué existe (2026-07-24): la agenda de las 7am se armaba solo con `calendly_pushes`, así
// que no veía las citas que un closer agenda a mano DENTRO de HubSpot. Medido contra un día
// real: 39 calls en Calendly, 58 meetings de closers en HubSpot, 49 en común → 8 calls de venta
// que solo existían en HubSpot y no se contaban.
//
// ⚠️ Por qué UNIÓN y no reemplazo: HubSpot no es superconjunto. Es el CRM de UNA empresa (30x),
// así que `tactical_investor` (Retia, otra empresa con su propio Calendly) no existe ahí: 0
// meetings con "Tactical" en 30 días. Cambiar Calendly por HubSpot pierde esos programas enteros.
//
// ⚠️ Corrección 2026-07-27 — este encabezado decía además que HubSpot no tiene meetings de
// `abogados` y que "4 closers del roster ni siquiera son owners ahí". Las dos afirmaciones eran
// artefactos de la medición, no del dato:
//   · la ventana de 7 días chocó con el tope de 1000 de searchMeetingsInWindow, que TRUNCABA EN
//     SILENCIO → los programas de bajo volumen salían en cero. `abogados` sí está (10 meetings,
//     "…Programa IA para Abogados EstadoX").
//   · Pablo Suarez sí es owner, con OTRO email (pablosuarez+hubspot@). Lo descartaba este mismo
//     filtro. De ahí `ownerToCloser` (ver abajo).
// Medido bien: HubSpot tiene las calls de 30x y sus estados. Sigue sin tener las de Retia.
//
// Filtros, en orden:
//   1. owner del meeting ∈ roster de closers → saca las reuniones del resto de la empresa
//      (de 216 meetings del día, 58 son de un closer).
//   2. título → programa (programFromTitle) → saca las internas de los propios closers.
//   3. dedup contra Calendly por closer + hora de inicio.

import { programFromTitle } from '../calendly/programs.js';

// `hs_meeting_start_time` llega como epoch ms (string) o como ISO según cómo se creó el
// registro. Devuelve ms o NaN.
export function meetingStartMs(value) {
  if (value == null || value === '') return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : Date.parse(value);
}

// ms → 'YYYY-MM-DD HH:MM:SS' UTC, el formato de call_start en SQLite (así las dos fuentes
// hablan el mismo idioma y el reporte no tiene que saber de dónde vino cada fila).
export const toDbUtc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// Clave de dedup: mismo closer + mismo minuto de arranque = la misma call en las dos fuentes.
// Al minuto y no al segundo porque Calendly guarda :00 y HubSpot puede traer segundos.
const dedupKey = (email, dbUtc) => `${String(email).toLowerCase().trim()}|${dbUtc.slice(0, 16)}`;

// Traduce meetings crudos de HubSpot a filas de agenda, descartando lo que no es una call de
// venta de un closer. `ownerEmailById` = { ownerId: email } (getOwnerEmailMap).
// `ownerToCloser` = { email de owner en HubSpot → email CANÓNICO de Calendly } (el mapa
// HUBSPOT_OWNER_TO_CLOSER de closers.js). Hace de filtro y de traductor a la vez: si el owner no
// está en el mapa no es closer nuestro, y si está, la fila sale con el email de Calendly.
//
// ⚠️ La canonicalización NO es cosmética. `dedupKey` compara por email, así que una fila que
// saliera con el email de HubSpot (pablosuarez+hubspot@) no deduplicaría contra su gemela de
// Calendly (pablosuarez@) y la call aparecería DOS VECES en la agenda del jefe.
// Devuelve [{ event_uuid, program, closer_email, prospect_name, call_start, source:'hubspot' }].
export function meetingsToCalls(meetings = [], { ownerEmailById = {}, ownerToCloser = {} } = {}) {
  const out = [];
  for (const m of meetings) {
    const props = m?.properties || {};
    const owner = String(ownerEmailById[String(props.hubspot_owner_id)] || '').toLowerCase();
    const email = owner ? ownerToCloser[owner] : null;
    if (!email) continue; // no es de un closer (o es un owner que no gestionamos)

    const program = programFromTitle(props.hs_meeting_title);
    if (!program) continue; // interna / sin naming de programa → no es call de venta

    const ms = meetingStartMs(props.hs_meeting_start_time);
    if (!Number.isFinite(ms)) continue; // sin hora no entra en ninguna agenda

    out.push({
      event_uuid: `hubspot:${m.id}`,
      program,
      closer_email: email,
      prospect_name: props.hs_meeting_title || null,
      call_start: toDbUtc(ms),
      source: 'hubspot',
      // Extras que solo consume el poll de pushes (agenda-poll.js). El reporte los ignora.
      meeting_id: m.id,
      created_at: props.hs_createdate || null,
      join_url: props.hs_meeting_external_url || props.hs_meeting_location || '',
    });
  }
  return out;
}

// Une las dos fuentes. Calendly MANDA: si la misma call está en las dos, se queda la fila de
// Calendly, que trae el programa por event_type (dato duro) en vez de inferido del título.
// Devuelve { calls, added, duplicates } — los conteos son para el log, no para el reporte.
export function mergeAgendaSources(calendlyCalls = [], hubspotCalls = []) {
  const seen = new Set(calendlyCalls.map((c) => dedupKey(c.closer_email, c.call_start)));
  const calls = [...calendlyCalls];
  let duplicates = 0;

  for (const h of hubspotCalls) {
    const k = dedupKey(h.closer_email, h.call_start);
    if (seen.has(k)) {
      duplicates++;
      continue;
    }
    seen.add(k);
    calls.push(h);
  }

  calls.sort((a, b) => String(a.call_start).localeCompare(String(b.call_start)));
  return { calls, added: calls.length - calendlyCalls.length, duplicates };
}
