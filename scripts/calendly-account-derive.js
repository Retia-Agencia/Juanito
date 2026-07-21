// scripts/calendly-account-derive.js
// Deriva, para una cuenta del registro (accounts.js), lo ÚNICO que no se puede inventar al
// sumar una agencia nueva:
//   1. Org URI          → GET /users/me → current_organization
//   2. event_types reales → los `kind=solo` salen en /event_types; los POOL NO — esos se leen
//      del campo `event_type` de reservas reales en /scheduled_events.
//   3. Hosts             → event_memberships[0].user_email de cada cita, para verificar que
//      coincidan EXACTO con closers.js (si no, cada poll alerta "closer sin mapear").
//
// NO imprime el token: lo lee de la env de la cuenta (accounts.js). Uso:
//   node scripts/calendly-account-derive.js retia
//   node scripts/calendly-account-derive.js retia --days-back=90 --days-fwd=45
//
// Ventana por defecto 45 días atrás → 30 adelante (para pescar el ET aunque no haya citas
// futuras). Si la cuenta no tiene NINGUNA cita en la ventana, no hay ET pool que derivar
// todavía: o se agranda la ventana, o se saca el ET del dashboard de Calendly, o se espera
// a la primera reserva.

import 'dotenv/config';
import { accountOf } from '../src/calendly/accounts.js';
import { CLOSERS, isIgnoredCloser } from '../src/calendly/closers.js';

const key = process.argv[2];
const acct = key && accountOf(key);
if (!acct) {
  console.error('Uso: node scripts/calendly-account-derive.js <accountKey>  (ej: retia)');
  process.exit(1);
}
const token = acct.token();
if (!token) {
  console.error(`✗ La cuenta '${key}' no tiene token. Setealo en .env (CALENDLY_TOKEN_${key.toUpperCase()}) y reintentá.`);
  process.exit(1);
}

const argv = process.argv.slice(3);
const numArg = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) || def : def;
};
const daysBack = numArg('days-back', 45);
const daysFwd = numArg('days-fwd', 30);

const API = 'https://api.calendly.com';
const H = { Authorization: `Bearer ${token}`, 'User-Agent': 'juanito-derive/1.0', Accept: 'application/json' };
const get = async (url) => {
  const r = await fetch(url, { headers: H });
  if (!r.ok) throw new Error(`${r.status} — ${(await r.text().catch(() => '')).slice(0, 160)}`);
  return r.json();
};

const me = await get(`${API}/users/me`);
const org = me.resource.current_organization;
console.log(`\n=== Cuenta '${key}' (${acct.label}) ===`);
console.log(`Org URI: ${org}`);
console.log(`→ en accounts.js:  orgUri: () => process.env.CALENDLY_ORG_URI_${key.toUpperCase()} || '${org}'`);

console.log(`\n--- event_types kind=solo (vía /event_types; los POOL no salen acá) ---`);
try {
  const et = await get(`${API}/event_types?organization=${encodeURIComponent(org)}&count=100`);
  const rows = et.collection || [];
  if (!rows.length) console.log('  (ninguno solo)');
  for (const e of rows) console.log(`  ${e.uri}  ·  ${e.name}  (${e.kind})`);
} catch (e) {
  console.log(`  error: ${e.message}`);
}

const min = new Date(Date.now() - daysBack * 864e5).toISOString();
const max = new Date(Date.now() + daysFwd * 864e5).toISOString();
console.log(`\n--- reservas ${min.slice(0, 10)} → ${max.slice(0, 10)} (saca ET pool + hosts) ---`);
const seenET = new Map();
const seenHost = new Map();
let url = `${API}/scheduled_events?organization=${encodeURIComponent(org)}&count=100&min_start_time=${min}&max_start_time=${max}&sort=start_time:asc`;
let total = 0;
while (url) {
  const d = await get(url);
  for (const ev of d.collection || []) {
    total++;
    const prev = seenET.get(ev.event_type);
    seenET.set(ev.event_type, { name: ev.name, count: (prev?.count || 0) + 1 });
    const host = ev.event_memberships?.[0]?.user_email?.toLowerCase();
    if (host) seenHost.set(host, (seenHost.get(host) || 0) + 1);
  }
  url = d.pagination?.next_page || null;
}
console.log(`  citas en la ventana: ${total}`);

console.log(`\n  event_types vistos (ESTE uri va a eventTypes en accounts.js):`);
if (!seenET.size) console.log('    (ninguna cita → sin ET que derivar; agrandá la ventana o esperá la 1ra reserva)');
for (const [uri, { name, count }] of seenET) console.log(`    ${uri}  ·  ${name}  (${count} citas)`);

console.log(`\n  hosts (verificá contra closers.js):`);
if (!seenHost.size) console.log('    (sin hosts en la ventana)');
for (const [email, count] of seenHost) {
  const mapped = CLOSERS[email]
    ? `✓ mapeado → ${CLOSERS[email].name} [${CLOSERS[email].account || '30x'}]`
    : isIgnoredCloser(email)
      ? 'ignorado (IGNORED_CLOSERS)'
      : '✗ SIN MAPEAR — agregar a closers.js o cada poll alertará';
  console.log(`    ${email}  (${count})  → ${mapped}`);
}
console.log('');
