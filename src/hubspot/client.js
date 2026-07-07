// src/hubspot/client.js
// IMPURO. Único archivo del módulo que toca la red. Lee los deals "Agendado" de
// HubSpot vía REST (SIN el SDK — un `fetch` a la API v3 basta y evita una dependencia
// nueva, igual que src/stripe/client.js y src/calendly/index.js).
//
// Autenticación: HUBSPOT_TOKEN (Private App token) en el header `Authorization: Bearer`.
// Scopes mínimos: crm.objects.deals.read + crm.schemas.deals.read. El bot SOLO lee.

const API = 'https://api.hubapi.com';

export const HUBSPOT_TOKEN = () => (process.env.HUBSPOT_TOKEN || '').trim();

// Predicado de gate: HubSpot desactivado si no hay token (mismo patrón que hasCloudApiCreds).
export function hasHubspotCreds(env = process.env) {
  return !!(env.HUBSPOT_TOKEN && String(env.HUBSPOT_TOKEN).trim());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Propiedades que traemos de cada deal. `pipeline` se pide para mapear el deal a su
// programa (el response no dice qué filterGroup matcheó). `telefono_de_contcato` va
// con el typo intencional: así se llama la propiedad real en HubSpot.
export const DEAL_PROPERTIES = [
  'calendly_host_email',
  'calendly_meeting_start_time',
  'telefono_de_contcato',
  'dealname',
  'dealstage',
  'pipeline',
];

// Busca deals cuyo (pipeline + dealstage) esté en `pipelines` Y cuyo
// `calendly_meeting_start_time` caiga en [minStartIso, maxStartIso]. Cada entrada de
// `pipelines` es { pipeline, stage } y se traduce a un filterGroup; los grupos van en
// OR entre sí, los filtros dentro de un grupo van en AND. Pagina con paging.next.after.
export async function searchDeals({ minStartIso, maxStartIso, pipelines, token = HUBSPOT_TOKEN() }) {
  if (!token) throw new Error('[hubspot] HUBSPOT_TOKEN no configurado');
  if (!pipelines?.length) throw new Error('[hubspot] sin pipelines configurados');

  const filterGroups = pipelines.map(({ pipeline, stage }) => ({
    filters: [
      { propertyName: 'pipeline', operator: 'EQ', value: pipeline },
      { propertyName: 'dealstage', operator: 'EQ', value: stage },
      { propertyName: 'calendly_meeting_start_time', operator: 'GTE', value: minStartIso },
      { propertyName: 'calendly_meeting_start_time', operator: 'LTE', value: maxStartIso },
    ],
  }));

  const out = [];
  let after = null;
  // Tope defensivo de páginas: 50 × 100 = 5k deals/día, muy por encima de lo esperado;
  // evita un bucle infinito si `paging.next` viniera mal.
  for (let page = 0; page < 50; page++) {
    const body = {
      filterGroups,
      properties: DEAL_PROPERTIES,
      sorts: [{ propertyName: 'calendly_meeting_start_time', direction: 'ASCENDING' }],
      limit: 100,
    };
    if (after) body.after = after;

    const data = await post('/crm/v3/objects/deals/search', body, token);
    out.push(...(data.results || []));
    after = data.paging?.next?.after || null;
    if (!after || (data.results || []).length === 0) break;
  }
  return out;
}

// Trae UN deal por id (re-validación en la entrega: ¿sigue "Agendado"? ¿cambió la hora?).
// `properties` es la lista a pedir (incluye la propiedad del join URL si está configurada).
export async function getDealById({ id, properties = DEAL_PROPERTIES, token = HUBSPOT_TOKEN() }) {
  if (!token) throw new Error('[hubspot] HUBSPOT_TOKEN no configurado');
  const qs = new URLSearchParams({ properties: properties.join(',') });
  return get(`/crm/v3/objects/deals/${encodeURIComponent(id)}?${qs}`, token);
}

// GET con Bearer + 429/Retry-After (misma disciplina que post()).
async function get(path, token, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 429 && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
      console.warn(`[hubspot] 429 rate limit — esperando ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`[hubspot] HubSpot ${res.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
}

// POST con Bearer. Maneja 429 (Retry-After), lee el body una sola vez y lanza con
// status + body truncado (mismo patrón que stripe/client.js y cloud-api.js). Los errores
// 401/403 se propagan → el motor los detecta con isAuthError() y alerta al admin.
async function post(path, body, token, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429 && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
      console.warn(`[hubspot] 429 rate limit — esperando ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`[hubspot] HubSpot ${res.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      return { results: [] };
    }
  }
}
