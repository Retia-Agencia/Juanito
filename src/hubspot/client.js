// src/hubspot/client.js
// Cliente read-only de HubSpot para Juanito. La credencial es un Personal Access Key
// (PAK), NO un Private App Token: el PAK es un refresh token codificado que se
// intercambia por un access token corto (~30 min) en localdevauth/v1/auth/refresh
// —el mismo mecanismo que usa la CLI de HubSpot— y ESE access token es el que va como
// Bearer. Cacheamos el access token y lo renovamos solo, sin pedir nada de nuevo.
//
// Scopes del PAK (2026-07-15, cuenta "30x" hubId 50929115): SOLO LECTURA —
//   crm.objects.{deals,contacts,companies,owners}.read + engagements (meetings/calls).
//   NO hay ningún .write → este módulo nunca modifica HubSpot.
//   NO trae leads.read, y /crm/v3/pipelines/* rechaza el token de usuario (403):
//   el mapa de pipelines/etapas es estático (ver docs de knowledge), no se consulta.
//
// Todo helper de este módulo es tolerante a fallos: si HubSpot no está configurado o la
// API falla, devuelve null/[] y loguea —nunca tira, para no romper el flujo que lo llama
// (ej. el push precall debe salir aunque HubSpot esté caído).

import { pipelineForProgram, pickDealForPipeline, classifyDealStage, isWonStage } from './deals.js';

const BASE = 'https://api.hubapi.com';
const PAK = () => process.env.HUBSPOT_PAT || '';

// Habilitado si hay PAK y el gate maestro no está en 'false'. Igual que los demás jobs:
// se autodesactiva solo si le falta la credencial.
export function isEnabled() {
  return Boolean(PAK()) && process.env.HUBSPOT_ENABLED !== 'false';
}

// ─── Access token: intercambio del PAK + cache con auto-refresh ───────────────

let _token = null; // { accessToken, expiresAt (ms) }
const REFRESH_MARGIN_MS = 120_000; // renueva 2 min antes de expirar

async function getAccessToken({ force = false } = {}) {
  const now = Date.now();
  if (!force && _token && _token.expiresAt - REFRESH_MARGIN_MS > now) {
    return _token.accessToken;
  }
  const res = await fetch(`${BASE}/localdevauth/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encodedOAuthRefreshToken: PAK() }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HubSpot token exchange ${res.status}: ${body.slice(0, 160)}`);
  }
  const data = await res.json();
  const accessToken = data.oauthAccessToken || data.accessToken;
  if (!accessToken) throw new Error('HubSpot token exchange: sin access token en la respuesta');
  _token = {
    accessToken,
    expiresAt: data.expiresAtMillis || now + 25 * 60_000, // fallback ~25 min
  };
  return accessToken;
}

// ─── HTTP con throttle + 429 + auto-refresh en 401 ────────────────────────────
// Rate limit de HubSpot: 100 req / 10 s. Con un gap mínimo de ~120ms vamos sobrados.

const MIN_GAP_MS = Number(process.env.HUBSPOT_MIN_GAP_MS || 120);
let _lastCall = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(path, { method = 'GET', body, retries = 3, _reauth = true } = {}) {
  if (!isEnabled()) throw new Error('HubSpot no configurado (HUBSPOT_PAT vacío)');
  const url = path.startsWith('http') ? path : BASE + path;

  const gap = Date.now() - _lastCall;
  if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);

  for (let attempt = 0; ; attempt++) {
    _lastCall = Date.now();
    const token = await getAccessToken();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    // Access token vencido/rechazado → forzar un re-intercambio una sola vez.
    if (res.status === 401 && _reauth) {
      await getAccessToken({ force: true });
      return request(path, { method, body, retries, _reauth: false });
    }
    if (res.status === 429 && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
      console.warn(`[HubSpot] 429 rate limit — esperando ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      continue;
    }
    if (!res.ok) {
      const b = await res.text().catch(() => '');
      throw new Error(`HubSpot ${res.status}: ${b.slice(0, 200)}`);
    }
    return res.json();
  }
}

// ─── Contactos ────────────────────────────────────────────────────────────────

const CONTACT_PROPS = ['firstname', 'lastname', 'email', 'phone', 'mobilephone'];

// Busca UN contacto por email exacto. Devuelve el objeto de HubSpot (con .properties)
// o null si no hay match / HubSpot está apagado / la API falla.
export async function findContactByEmail(email) {
  if (!isEnabled() || !email) return null;
  try {
    const data = await request('/crm/v3/objects/contacts/search', {
      method: 'POST',
      body: {
        filterGroups: [
          { filters: [{ propertyName: 'email', operator: 'EQ', value: String(email).trim().toLowerCase() }] },
        ],
        properties: CONTACT_PROPS,
        limit: 1,
      },
    });
    return data.results?.[0] || null;
  } catch (e) {
    console.warn(`[HubSpot] findContactByEmail(${email}) falló: ${e.message}`);
    return null;
  }
}

// Teléfono de un contacto por email: prueba `phone` y `mobilephone`. Devuelve el string
// crudo de HubSpot (buildLeadLink ya limpia no-dígitos) o null si no hay ninguno.
export async function getContactPhone(email) {
  const c = await findContactByEmail(email);
  if (!c) return null;
  const p = c.properties || {};
  const phone = (p.mobilephone || p.phone || '').trim();
  return phone || null;
}

// ─── Pipelines y deals (modelo nudge) ─────────────────────────────────────────

// Etapas de un pipeline, vía el endpoint legacy (el v3 /crm/v3/pipelines/* rechaza el
// token de usuario con 403; el legacy /crm-pipelines/v1 sí responde). Cachea TODOS los
// pipelines en la primera llamada — casi nunca cambian. Devuelve
// [{ stageId, label, displayOrder, isClosed }] o [] si falla.
let _pipelinesCache = null; // { [pipelineId]: stages[] }

async function loadPipelines() {
  if (_pipelinesCache) return _pipelinesCache;
  const data = await request('/crm-pipelines/v1/pipelines/deals');
  const map = {};
  for (const p of data.results || []) {
    map[String(p.pipelineId)] = (p.stages || []).map((s) => ({
      stageId: String(s.stageId),
      label: s.label,
      displayOrder: s.displayOrder,
      isClosed: s.metadata?.isClosed === 'true',
    }));
  }
  _pipelinesCache = map;
  return map;
}

export async function getPipelineStages(pipelineId) {
  try {
    const map = await loadPipelines();
    return map[String(pipelineId)] || [];
  } catch (e) {
    console.warn(`[HubSpot] getPipelineStages(${pipelineId}) falló: ${e.message}`);
    return [];
  }
}

// Deals asociados a un contacto, con las props que necesita el matcher. [] si falla.
// `agenda_status` + `hs_next_meeting_*` alimentan la cosecha por estado de agenda (§18.AG):
// agenda_status da show/no-show/reagenda directo; next_meeting_start_time distingue una
// "Programada" vencida (nudge) de una con cita futura (no molestar).
const DEAL_PROPS = [
  'dealname',
  'pipeline',
  'dealstage',
  'hs_lastmodifieddate',
  'hubspot_owner_id',
  'agenda_status',
  'hs_next_meeting_start_time',
  'hs_next_meeting_name',
];

export async function getContactDeals(contactId) {
  if (!isEnabled() || !contactId) return [];
  try {
    const assoc = await request(`/crm/v3/objects/contacts/${contactId}/associations/deals`);
    const ids = (assoc.results || []).map((r) => r.toObjectId || r.id).filter(Boolean);
    if (!ids.length) return [];
    const batch = await request('/crm/v3/objects/deals/batch/read', {
      method: 'POST',
      body: { properties: DEAL_PROPS, inputs: ids.map((id) => ({ id: String(id) })) },
    });
    return batch.results || [];
  } catch (e) {
    console.warn(`[HubSpot] getContactDeals(${contactId}) falló: ${e.message}`);
    return [];
  }
}

// Matcher del modelo nudge: dada una call (email del lead + programa), encuentra el deal
// y clasifica su estado. Devuelve un objeto que el engine puede accionar directo:
//   { covered:false }                              → programa sin pipeline aquí → Push 4 clásico
//   { covered:true, contact:null, ... reason:'no_contact' } → lead no está en HubSpot
//   { covered:true, deal:null,   reason:'no_deal' }         → contacto sin deal en el pipeline
//   { covered:true, deal, status:'stale'|'resolved'|'unknown', contact, pipelineId }
// Tolerante a fallos: cualquier error → { covered:true, error } (el engine cae a preguntar).
export async function matchCallToDeal({ email, programKey }) {
  const pipelineId = pipelineForProgram(programKey);
  if (!pipelineId) return { covered: false };
  if (!isEnabled() || !email) return { covered: true, contact: null, deal: null, reason: 'no_contact' };
  try {
    const contact = await findContactByEmail(email);
    if (!contact) return { covered: true, contact: null, deal: null, reason: 'no_contact', pipelineId };
    const deals = await getContactDeals(contact.id);
    const deal = pickDealForPipeline(deals, pipelineId);
    if (!deal) return { covered: true, contact, deal: null, reason: 'no_deal', pipelineId };
    const stages = await getPipelineStages(pipelineId);
    const status = classifyDealStage(deal.properties?.dealstage, stages);
    // §18.AG: campos de agenda para la cosecha por estado (la evolución del nudge).
    const props = deal.properties || {};
    return {
      covered: true,
      contact,
      deal,
      status,
      pipelineId,
      agendaStatus: props.agenda_status || null,
      nextMeetingStart: props.hs_next_meeting_start_time || null,
      nextMeetingName: props.hs_next_meeting_name || null,
      // Cosecha de venta: eje aparte de la asistencia (agenda_status). Alimenta `resultado`
      // cuando la cosecha marca 'show' — un show con el deal ya en Ganado es una venta.
      won: isWonStage(deal.properties?.dealstage, stages),
    };
  } catch (e) {
    console.warn(`[HubSpot] matchCallToDeal(${email}, ${programKey}) falló: ${e.message}`);
    return { covered: true, error: e.message };
  }
}

// ─── Setteo: dueños + contactos tocados (§18.AH) ──────────────────────────────
// Fuente del conteo de setteos por closer. Todo read-only (owners.read + contacts.read, ya en
// el scope del PAK). La lógica pura de agregación vive en setteo.js; acá solo el fetch.

// Mapa { ownerId → email } de TODOS los owners del portal. Cachea en proceso (como los
// pipelines) — el roster de owners casi nunca cambia. Tolerante a fallos → {}.
let _ownersCache = null;

export async function getOwnerEmailMap() {
  if (_ownersCache) return _ownersCache;
  if (!isEnabled()) return {};
  try {
    const map = {};
    let after = null;
    do {
      const q = `/crm/v3/owners?limit=100${after ? `&after=${after}` : ''}`;
      const data = await request(q);
      for (const o of data.results || []) {
        if (o.id && o.email) map[String(o.id)] = String(o.email).toLowerCase();
      }
      after = data.paging?.next?.after || null;
    } while (after);
    _ownersCache = map;
    return map;
  } catch (e) {
    console.warn(`[HubSpot] getOwnerEmailMap falló: ${e.message}`);
    return {};
  }
}

// ─── Meetings (agenda del día, §18.AM) ────────────────────────────────────────
// Meetings con `hs_meeting_start_time` en [fromIso, untilIso). Trae TODOS los de la cuenta —
// el filtrado (owner ∈ closers, título → programa) es puro y vive en hubspot/meetings.js.
// Pagina hasta agotar, con tope duro: un día entero de la empresa son ~220 meetings, así que
// 1000 es holgado y evita que un rango mal calculado dispare cientos de requests.
// `hs_createdate` alimenta el Push 0 (¿es una reserva RECIÉN hecha para hoy?); el join_url y la
// location, el Push 3 (el link de la llamada). `hs_meeting_outcome` se trae pero NO se usa para
// decidir nada: medido sobre calls reales está vacío o en 'SCHEDULED' en casi todo el volumen
// (1 sola 'COMPLETED' en 250 calls). El estado real vive en `agenda_status` del DEAL.
const MEETING_PROPS = [
  'hs_meeting_start_time',
  'hs_meeting_title',
  'hs_meeting_outcome',
  'hubspot_owner_id',
  'hs_createdate',
  'hs_meeting_external_url',
  'hs_meeting_location',
];
const MEETINGS_HARD_CAP = 1000;

export async function searchMeetingsInWindow({ fromIso, untilIso }) {
  if (!isEnabled() || !fromIso || !untilIso) return [];
  try {
    const out = [];
    let after = null;
    do {
      const data = await request('/crm/v3/objects/meetings/search', {
        method: 'POST',
        body: {
          filterGroups: [
            {
              filters: [
                {
                  propertyName: 'hs_meeting_start_time',
                  operator: 'BETWEEN',
                  value: String(Date.parse(fromIso)),
                  highValue: String(Date.parse(untilIso)),
                },
              ],
            },
          ],
          properties: MEETING_PROPS,
          limit: 100,
          ...(after ? { after } : {}),
        },
      });
      out.push(...(data.results || []));
      after = data.paging?.next?.after || null;
    } while (after && out.length < MEETINGS_HARD_CAP);
    // El tope existe para que un rango mal calculado no dispare cientos de requests, pero cortar
    // en silencio es peor que el problema que evita: una ventana grande devuelve una foto PARCIAL
    // que se lee como completa. Pasó de verdad (2026-07-27): una sonda de 7 días se truncó acá y
    // los programas de bajo volumen aparecieron en CERO, lo que casi cuesta la decisión de sacar
    // `abogados` y `developers` de HubSpot creyendo que no estaban.
    if (after && out.length >= MEETINGS_HARD_CAP) {
      console.warn(
        `[HubSpot] searchMeetingsInWindow TRUNCADO en ${MEETINGS_HARD_CAP} meetings ` +
          `(${fromIso} → ${untilIso}) — hay más y NO se trajeron: la ventana es demasiado grande.`
      );
    }
    return out;
  } catch (e) {
    console.warn(`[HubSpot] searchMeetingsInWindow falló: ${e.message}`);
    return []; // la agenda degrada a solo-Calendly, no se cae
  }
}

// El LEAD de un meeting: su primer contacto asociado, con nombre y teléfono. Lo necesita el push
// precall de las citas que solo viven en HubSpot — sin esto el mensaje saldría con el título del
// meeting como nombre del prospecto ("Entrevista de Postulación Programa…") y sin número al cual
// escribirle. Tolerante a fallos: null si no hay contacto, si HubSpot está apagado o si falla.
export async function getMeetingContact(meetingId) {
  if (!isEnabled() || !meetingId) return null;
  try {
    const assoc = await request(`/crm/v3/objects/meetings/${meetingId}/associations/contacts`);
    const id = (assoc.results || []).map((r) => r.toObjectId || r.id).filter(Boolean)[0];
    if (!id) return null;
    const c = await request(`/crm/v3/objects/contacts/${id}?properties=${CONTACT_PROPS.join(',')}`);
    const p = c.properties || {};
    const name = `${p.firstname || ''} ${p.lastname || ''}`.trim();
    return {
      id: c.id,
      name: name || null,
      email: p.email || null,
      phone: (p.mobilephone || p.phone || '').trim() || null,
    };
  } catch (e) {
    console.warn(`[HubSpot] getMeetingContact(${meetingId}) falló: ${e.message}`);
    return null;
  }
}

// Contactos de un owner con actividad de contacto registrada (`notes_last_contacted`) dentro de
// [sinceIso, untilIso). Uno por lead → dedup natural (la unidad "1 lead tocado = 1 setteo").
// Pagina hasta agotar. Devuelve [{ id, ownerId, email, name, lastContacted }] o [] si falla.
const TOUCHED_PROPS = ['firstname', 'lastname', 'email', 'hubspot_owner_id', 'notes_last_contacted', 'num_contacted_notes'];

export async function searchTouchedContacts({ ownerId, sinceIso, untilIso }) {
  if (!isEnabled() || !ownerId || !sinceIso || !untilIso) return [];
  try {
    const out = [];
    let after = null;
    do {
      const data = await request('/crm/v3/objects/contacts/search', {
        method: 'POST',
        body: {
          filterGroups: [
            {
              filters: [
                { propertyName: 'hubspot_owner_id', operator: 'EQ', value: String(ownerId) },
                {
                  propertyName: 'notes_last_contacted',
                  operator: 'BETWEEN',
                  value: String(Date.parse(sinceIso)),
                  highValue: String(Date.parse(untilIso)),
                },
              ],
            },
          ],
          properties: TOUCHED_PROPS,
          limit: 100,
          ...(after ? { after } : {}),
        },
      });
      for (const c of data.results || []) {
        const p = c.properties || {};
        out.push({
          id: c.id,
          ownerId: String(p.hubspot_owner_id || ownerId),
          email: p.email || null,
          name: `${p.firstname || ''} ${p.lastname || ''}`.trim(),
          lastContacted: p.notes_last_contacted || null,
        });
      }
      after = data.paging?.next?.after || null;
    } while (after);
    return out;
  } catch (e) {
    console.warn(`[HubSpot] searchTouchedContacts(${ownerId}) falló: ${e.message}`);
    return [];
  }
}

// Discriminador setteo vs. call: ¿alguno de los deals del contacto tiene `agenda_status`?
// True = tiene (o tuvo) una cita → es lead de call, NO setteo. Reusa getContactDeals (trae
// agenda_status en DEAL_PROPS). Ante error, false (no descartar de más: mejor contar un setteo
// de sobra que perder la gestión).
export async function contactHasScheduledDeal(contactId) {
  if (!isEnabled() || !contactId) return false;
  const deals = await getContactDeals(contactId);
  return deals.some((d) => Boolean(d.properties?.agenda_status));
}

// ─── Diagnóstico ──────────────────────────────────────────────────────────────

// Ping barato para el smoke/healthcheck: confirma que el PAK intercambia y que la API
// responde. Devuelve { ok, hubId?, error? }.
export async function ping() {
  if (!isEnabled()) return { ok: false, error: 'HUBSPOT_PAT vacío' };
  try {
    const info = await request('/account-info/v3/details');
    return { ok: true, hubId: info.portalId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export const __private = { getAccessToken };
