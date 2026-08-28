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
import { normalizePhone } from '../common/utils.js';
import { fetchConDeadline } from '../common/http.js';
// Solo el mapa de alias owner→closer (ownerIdForCloser). closers.js no importa nada de
// hubspot/, así que no hay ciclo.
import { HUBSPOT_OWNER_TO_CLOSER } from '../calendly/closers.js';

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
  const res = await fetchConDeadline(`${BASE}/localdevauth/v1/auth/refresh`, {
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
    const res = await fetchConDeadline(url, {
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

// Teléfono del lead POR NOMBRE, cuando buscarlo por su correo no dio nada.
//
// Causa medida (2026-07-28, casos Francisco Patarroyo y Diana Fonseca): el lead llena el
// formulario con un correo y agenda en Calendly con OTRO. HubSpot termina con DOS contactos
// para la misma persona, y el que Juanito consulta —el del correo de Calendly— es un cascarón
// creado ~2 min después: sin apellido, sin teléfono y sin deal. El teléfono bueno vive en el
// gemelo, el del formulario. Antes de esto el push salía "sin teléfono → mándalo manual"
// teniendo el número a un search de distancia.
//
// REGLA DE SEGURIDAD (lo importante de esta función): solo devuelve algo si NO hay ambigüedad.
// Se juntan los teléfonos de TODOS los homónimos y se comparan ya normalizados a dígitos; si
// discrepan, devuelve null — que es exactamente el comportamiento de antes ("mándalo manual").
// Mandarle al closer el número de otra persona con el mismo nombre es peor que no mandarle
// ninguno: el push precall se envía al lead. Mismo criterio que resolveCloserByPushName en
// calendly/closers.js (ambiguo = null = seguro).
//
// Un nombre de UNA sola palabra no identifica a nadie → null sin consultar.
// READ-ONLY: solo /search. Tolerante a fallos como el resto del módulo.
// Contactos GEMELOS: los homónimos del lead en HubSpot. Es la vía para llegar a la persona
// cuando el correo con el que agendó no es el del formulario. READ-ONLY (solo /search).
// Un nombre de UNA palabra no identifica a nadie → [] sin consultar la API.
export async function searchContactsByName(fullName) {
  if (!isEnabled() || !fullName) return [];
  const words = String(fullName).trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return [];
  const firstname = words[0];
  const lastname = words[words.length - 1]; // "Francisco Leonardo Patarroyo" → Patarroyo
  try {
    const data = await request('/crm/v3/objects/contacts/search', {
      method: 'POST',
      body: {
        filterGroups: [
          {
            filters: [
              { propertyName: 'firstname', operator: 'CONTAINS_TOKEN', value: firstname },
              { propertyName: 'lastname', operator: 'CONTAINS_TOKEN', value: lastname },
            ],
          },
        ],
        properties: CONTACT_PROPS,
        limit: 20,
      },
    });
    return data.results || [];
  } catch (e) {
    console.warn(`[HubSpot] searchContactsByName(${fullName}) falló: ${e.message}`);
    return [];
  }
}

export async function findPhoneByName(fullName) {
  try {
    const candidatos = await searchContactsByName(fullName);
    if (!candidatos.length) return null;
    // Teléfono crudo por candidato (buildLeadLink ya limpia no-dígitos), indexado por su
    // forma NORMALIZADA: así "+573215087717" y "573215087717" cuentan como el MISMO número
    // (caso Diana: dos contactos homónimos, un solo teléfono real → no es ambigüedad).
    const porNumero = new Map();
    for (const c of candidatos) {
      const p = c.properties || {};
      const crudo = (p.mobilephone || p.phone || '').trim();
      if (!crudo) continue;
      const norm = normalizePhone(crudo);
      if (norm && !porNumero.has(norm)) porNumero.set(norm, crudo);
    }
    if (porNumero.size !== 1) {
      if (porNumero.size > 1) {
        console.warn(
          `[HubSpot] "${fullName}": ${candidatos.length} homónimos con ${porNumero.size} teléfonos distintos → NO adivino, va sin número`
        );
      }
      return null;
    }
    return [...porNumero.values()][0];
  } catch (e) {
    console.warn(`[HubSpot] findPhoneByName(${fullName}) falló: ${e.message}`);
    return null;
  }
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

// Etapas en las que un lead TODAVÍA se settea. El proceso de ventas (verificado contra los 3
// pipelines reales el 2026-08-04) es:
//   Potencial → Registrado → En gestión → Contactado → Calificado → Agendado → Atendido → …
// El closer persigue a los de **Registrado** y **Calificado** para que agenden; en cuanto
// agendan salen del setteo. Por eso son estas dos y no las de al lado.
//
// Se resuelven por LABEL y no por id: los ids son distintos en cada pipeline (hay 3) y
// cambiarían si se recrea uno. Tolerante a acentos y mayúsculas, igual que deals.js.
// Override por si el equipo renombra una etapa: HUBSPOT_SETTEO_STAGES=registrado,calificado
const SETTEO_STAGE_LABELS = () =>
  (process.env.HUBSPOT_SETTEO_STAGES || 'registrado,calificado')
    .split(',')
    .map((s) => sinAcentos(s))
    .filter(Boolean);

const sinAcentos = (s) =>
  String(s || '').trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

// Set con los stageId de TODOS los pipelines cuyas etapas son de setteo. Vacío si falla.
export async function setteableStageIds() {
  try {
    const map = await loadPipelines();
    const quiero = new Set(SETTEO_STAGE_LABELS());
    const ids = new Set();
    for (const stages of Object.values(map))
      for (const s of stages) if (quiero.has(sinAcentos(s.label))) ids.add(String(s.stageId));
    return ids;
  } catch (e) {
    console.warn(`[HubSpot] setteableStageIds falló: ${e.message}`);
    return new Set();
  }
}

// Deals de VARIOS contactos en 2 llamadas (asociaciones en batch + lectura en batch), sin
// importar cuántos contactos sean. La alternativa —una vuelta por candidato— eran hasta 14
// llamadas para UN lead ambiguo, y la API ya tira 429 con facilidad.
// Devuelve Map(contactId → [{ dealstage, ownerId }]). Map vacío ante cualquier fallo.
export async function dealsOfContacts(contactIds = []) {
  const out = new Map();
  const ids = [...new Set(contactIds.map(String).filter(Boolean))].slice(0, 20);
  if (!isEnabled() || !ids.length) return out;
  try {
    const assoc = await request('/crm/v4/associations/contacts/deals/batch/read', {
      method: 'POST',
      body: { inputs: ids.map((id) => ({ id })) },
    });
    const porContacto = new Map();
    const todos = new Set();
    for (const r of assoc.results || []) {
      const dealIds = (r.to || []).map((t) => String(t.toObjectId || t.id)).filter(Boolean);
      porContacto.set(String(r.from?.id), dealIds);
      for (const d of dealIds) todos.add(d);
    }
    if (!todos.size) return out;

    const batch = await request('/crm/v3/objects/deals/batch/read', {
      method: 'POST',
      body: {
        properties: ['dealstage', 'hubspot_owner_id'],
        inputs: [...todos].slice(0, 100).map((id) => ({ id })),
      },
    });
    const props = new Map((batch.results || []).map((d) => [String(d.id), d.properties || {}]));
    for (const [cid, dealIds] of porContacto) {
      out.set(
        cid,
        dealIds
          .map((id) => props.get(id))
          .filter(Boolean)
          .map((p) => ({
            dealstage: p.dealstage ? String(p.dealstage) : null,
            ownerId: p.hubspot_owner_id ? String(p.hubspot_owner_id) : null,
          }))
      );
    }
  } catch (e) {
    console.warn(`[HubSpot] dealsOfContacts falló: ${e.message}`);
  }
  return out;
}

// ownerId de HubSpot de un closer, a partir de su email CANÓNICO (el de Calendly). Pasa por
// HUBSPOT_OWNER_TO_CLOSER porque no siempre son el mismo correo: Pablo Suarez es owner con
// `pablosuarez+hubspot@` y hostea con `pablosuarez@` (§18.AN). null si no se resuelve.
export async function ownerIdForCloser(email) {
  const e = String(email || '').toLowerCase().trim();
  if (!e || !isEnabled()) return null;
  try {
    const map = await getOwnerEmailMap(); // ownerId → email del owner
    for (const [ownerId, ownerEmail] of Object.entries(map)) {
      if (ownerEmail === e || HUBSPOT_OWNER_TO_CLOSER[ownerEmail] === e) return String(ownerId);
    }
  } catch (e2) {
    console.warn(`[HubSpot] ownerIdForCloser(${e}) falló: ${e2.message}`);
  }
  return null;
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
// Deals del pipeline que cuelgan de los GEMELOS del lead (mismos nombre y apellido, otro
// correo). Es la red que atrapa el caso medido el 2026-07-28: el lead agenda con un correo
// distinto al del formulario, HubSpot crea un contacto aparte sin deal, y el deal REAL —que
// ya existe y ya es del closer— queda colgado del contacto del formulario.
// Devuelve deals ÚNICOS por id, saltándose el contacto que ya se revisó por correo.
// READ-ONLY. Tope de 5 gemelos: más que eso es un nombre demasiado común para confiar.
async function dealsViaTwins({ name, pipelineId, skipContactId }) {
  const gemelos = (await searchContactsByName(name)).filter((c) => String(c.id) !== String(skipContactId));
  const porId = new Map();
  for (const g of gemelos.slice(0, 5)) {
    const deal = pickDealForPipeline(await getContactDeals(g.id), pipelineId);
    if (deal && !porId.has(String(deal.id))) porId.set(String(deal.id), { deal, contact: g });
  }
  return [...porId.values()];
}

export async function matchCallToDeal({ email, programKey, name = null }) {
  const pipelineId = pipelineForProgram(programKey);
  if (!pipelineId) return { covered: false };
  if (!isEnabled() || !email) return { covered: true, contact: null, deal: null, reason: 'no_contact' };
  try {
    const contact = await findContactByEmail(email);
    const deals = contact ? await getContactDeals(contact.id) : [];
    let deal = contact ? pickDealForPipeline(deals, pipelineId) : null;
    let viaTwin = null;

    // Sin deal por el correo de la reunión → buscar al gemelo ANTES de declarar que no existe.
    // Decir "no está en HubSpot, créalo" cuando el deal sí existe hace que el closer cree un
    // duplicado, que es exactamente lo que ops pidió evitar.
    if (!deal && name) {
      const candidatos = await dealsViaTwins({ name, pipelineId, skipContactId: contact?.id });
      if (candidatos.length === 1) {
        deal = candidatos[0].deal;
        viaTwin = candidatos[0].contact;
        console.log(
          `[HubSpot] "${name}": el deal ${deal.id} estaba colgado de otro contacto (${viaTwin.properties?.email}) — no es un lead sin deal`
        );
      } else if (candidatos.length > 1) {
        // Varios homónimos CON deal (caso real: dos "Diana Fonseca"). No elegimos por el
        // closer: le mostramos los candidatos. Adivinar aquí sería señalarle el deal de otra
        // persona, y ese error es más caro que pedirle 10 segundos de revisión.
        console.warn(`[HubSpot] "${name}": ${candidatos.length} deals de homónimos → que revise el closer`);
        return {
          covered: true,
          contact,
          deal: null,
          reason: 'ambiguous_twin',
          twinDealIds: candidatos.map((c) => String(c.deal.id)),
          pipelineId,
        };
      }
    }

    if (!contact && !deal) return { covered: true, contact: null, deal: null, reason: 'no_contact', pipelineId };
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
      // Contacto del que colgaba el deal cuando NO era el del correo de la reunión. El mensaje
      // al closer lo menciona para que entienda por qué no lo encontraba donde lo buscaba.
      viaTwin: viaTwin ? { id: viaTwin.id, email: viaTwin.properties?.email || null } : null,
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

// Meetings CREADOS en [sinceIso, ahora), sin importar cuándo arrancan. Es la señal barata para
// detectar la reagenda hecha dentro del CRM (§18.AO): reagendar crea un meeting nuevo, así que
// mirar "lo recién creado" cuesta 1 request por ciclo — mucho menos que rastrear meses de agenda
// hacia adelante buscando el reemplazo. Volumen medido: ~4.7 meetings/h en toda la empresa, de
// los cuales ~1.1/h son calls de un closer.
export async function searchMeetingsCreatedSince({ sinceIso, cap = 300 }) {
  if (!isEnabled() || !sinceIso) return [];
  try {
    const out = [];
    let after = null;
    do {
      const data = await request('/crm/v3/objects/meetings/search', {
        method: 'POST',
        body: {
          filterGroups: [
            { filters: [{ propertyName: 'hs_createdate', operator: 'GTE', value: String(Date.parse(sinceIso)) }] },
          ],
          properties: MEETING_PROPS,
          limit: 100,
          ...(after ? { after } : {}),
        },
      });
      out.push(...(data.results || []));
      after = data.paging?.next?.after || null;
    } while (after && out.length < cap);
    if (after && out.length >= cap) {
      console.warn(`[HubSpot] searchMeetingsCreatedSince truncado en ${cap} (desde ${sinceIso}) — ventana muy grande`);
    }
    return out;
  } catch (e) {
    console.warn(`[HubSpot] searchMeetingsCreatedSince falló: ${e.message}`);
    return [];
  }
}

// ─── Asociaciones en batch (v4) ───────────────────────────────────────────────
// Una sola llamada por cada 100 ids, en vez de una por meeting. Es lo que hace viable correr la
// detección de reagendas en cada ciclo del poll (cada 5 min) sin castigar el rate limit.

async function batchAssoc(fromType, toType, ids) {
  const out = {};
  if (!isEnabled() || !ids?.length) return out;
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const data = await request(`/crm/v4/associations/${fromType}/${toType}/batch/read`, {
        method: 'POST',
        body: { inputs: ids.slice(i, i + 100).map((id) => ({ id: String(id) })) },
      });
      for (const r of data.results || []) {
        const to = (r.to || []).map((t) => String(t.toObjectId)).filter(Boolean);
        if (to.length) out[String(r.from?.id)] = to;
      }
    }
    return out;
  } catch (e) {
    console.warn(`[HubSpot] batchAssoc ${fromType}→${toType} falló: ${e.message}`);
    return {}; // sin asociaciones no se detecta la reagenda; nada se cancela por error
  }
}

// { meetingId: contactId } — el PRIMER contacto asociado, que es el lead de la call.
export async function getContactsOfMeetings(meetingIds = []) {
  const raw = await batchAssoc('meetings', 'contacts', meetingIds);
  return Object.fromEntries(Object.entries(raw).map(([mid, contacts]) => [mid, contacts[0]]));
}

// { contactId: [meetingId, …] } — todas las citas del lead, para encontrar la que quedó vieja.
export async function getMeetingsOfContacts(contactIds = []) {
  return batchAssoc('contacts', 'meetings', contactIds);
}

// Lee meetings por id, con las mismas props que la búsqueda → el resultado se puede pasar tal
// cual a `meetingsToCalls`.
export async function getMeetingsByIds(meetingIds = []) {
  if (!isEnabled() || !meetingIds.length) return [];
  try {
    const out = [];
    for (let i = 0; i < meetingIds.length; i += 100) {
      const data = await request('/crm/v3/objects/meetings/batch/read', {
        method: 'POST',
        body: { properties: MEETING_PROPS, inputs: meetingIds.slice(i, i + 100).map((id) => ({ id: String(id) })) },
      });
      out.push(...(data.results || []));
    }
    return out;
  } catch (e) {
    console.warn(`[HubSpot] getMeetingsByIds falló: ${e.message}`);
    return [];
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
