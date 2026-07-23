// Ad-hoc, read-only: vuelca TODAS las propiedades no vacías de un contacto (por nombre)
// y de sus deals asociados. Para corroborar qué campos de HubSpot sirven para contar setteos.
// Uso: node scripts/inspect-lead.mjs "Miguel" "Pimpollo"
import fs from 'node:fs';

const [firstArg, lastArg] = process.argv.slice(2);
const FIRST = firstArg || 'Miguel';
const LAST = lastArg || 'Pimpollo';

// --- cargar HUBSPOT_PAT del .env sin dependencias ---
const env = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
const PAK = process.env.HUBSPOT_PAT;
if (!PAK) { console.error('No HUBSPOT_PAT'); process.exit(1); }

const BASE = 'https://api.hubapi.com';
let token = null;
async function getToken() {
  if (token) return token;
  const r = await fetch(`${BASE}/localdevauth/v1/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encodedOAuthRefreshToken: PAK }),
  });
  if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`);
  const d = await r.json();
  token = d.oauthAccessToken || d.accessToken;
  return token;
}
async function api(path, opts = {}) {
  const t = await getToken();
  const body = opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body;
  const r = await fetch(path.startsWith('http') ? path : BASE + path, {
    ...opts,
    body,
    headers: { Authorization: `Bearer ${t}`, Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function allPropNames(objectType) {
  const d = await api(`/crm/v3/properties/${objectType}`);
  return (d.results || []).map((p) => p.name);
}

function printProps(title, props) {
  console.log(`\n===== ${title} =====`);
  const entries = Object.entries(props || {})
    .filter(([, v]) => v !== null && v !== '' && v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of entries) {
    const val = String(v).length > 120 ? String(v).slice(0, 117) + '...' : v;
    console.log(`  ${k.padEnd(38)} = ${val}`);
  }
  console.log(`  (${entries.length} propiedades con valor)`);
}

(async () => {
  // 1) buscar contacto por texto libre; elegir el PRIMERO que tenga deal asociado
  const search = await api('/crm/v3/objects/contacts/search', {
    method: 'POST',
    body: { query: `${FIRST} ${LAST}`.trim(), properties: ['firstname', 'lastname', 'email'], limit: 20 },
  });
  const hits = search.results || [];
  console.log(`Contactos para "${FIRST} ${LAST}": ${hits.length}`);
  if (!hits.length) { console.log('Sin match.'); return; }

  let contact = null;
  let preloadedDealIds = null;
  for (const h of hits) {
    const a = await api(`/crm/v3/objects/contacts/${h.id}/associations/deals`);
    const ids = (a.results || []).map((r) => r.toObjectId || r.id).filter(Boolean);
    console.log(`  id=${h.id} ${h.properties.firstname} ${h.properties.lastname} <${h.properties.email || ''}> — deals: ${ids.length}`);
    if (ids.length && !contact) { contact = h; preloadedDealIds = ids; }
  }
  if (!contact) { contact = hits[0]; } // ninguno con deal → usa el primero igual
  console.log(`\n>>> Analizando: ${contact.properties.firstname} ${contact.properties.lastname} (id ${contact.id})`);
  // 2) volcar TODAS las props del contacto
  const cNames = await allPropNames('contacts');
  const cFull = await api('/crm/v3/objects/contacts/batch/read', {
    method: 'POST',
    body: { properties: cNames, inputs: [{ id: contact.id }] },
  });
  printProps(`CONTACTO ${contact.id}`, cFull.results?.[0]?.properties);

  // 3) deals asociados, TODAS sus props
  const assoc = await api(`/crm/v3/objects/contacts/${contact.id}/associations/deals`);
  const dealIds = (assoc.results || []).map((r) => r.toObjectId || r.id).filter(Boolean);
  console.log(`\nDeals asociados: ${dealIds.length} -> [${dealIds.join(', ')}]`);
  if (dealIds.length) {
    const dNames = await allPropNames('deals');
    const dFull = await api('/crm/v3/objects/deals/batch/read', {
      method: 'POST',
      body: { properties: dNames, inputs: dealIds.map((id) => ({ id: String(id) })) },
    });
    for (const d of dFull.results || []) printProps(`DEAL ${d.id}`, d.properties);
  }

  // 4) owner -> nombre
  const ownerId = cFull.results?.[0]?.properties?.hubspot_owner_id;
  if (ownerId) {
    try {
      const o = await api(`/crm/v3/owners/${ownerId}`);
      console.log(`\nOwner del contacto: ${o.firstName || ''} ${o.lastName || ''} <${o.email || ''}> (id ${ownerId})`);
    } catch (e) { console.log(`\nOwner ${ownerId}: no resuelto (${e.message})`); }
  }
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
