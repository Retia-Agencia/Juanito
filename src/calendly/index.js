// src/calendly/index.js
// Cliente de la API v2 de Calendly + helpers PUROS (sin dependencias nativas:
// no importa la DB, así que se puede testear sin compilar better-sqlite3).
//
// Hallazgos de la validación contra la cuenta real:
//  - El WAF de Calendly rechaza el User-Agent por defecto de algunos clientes →
//    enviamos un User-Agent explícito.
//  - El teléfono del prospecto vive en invitee.text_reminder_number (NO en
//    questions_and_answers, que viene vacío). Puede ser null en reservas
//    instant_book / reagendadas.
//  - invitee.first_name viene null → parseamos el primer nombre de invitee.name.

const API = 'https://api.calendly.com';

const TOKEN = () => process.env.CALENDLY_TOKEN || '';
const TZ = () => process.env.TZ || 'America/Bogota';

export const GROUP_URI = () =>
  process.env.CALENDLY_GROUP_URI ||
  'https://api.calendly.com/groups/61f57776-40d4-4feb-bdbc-654f397ba0c6';

// event_types de los dos programas (resueltos contra la cuenta real):
//  - AI Second Brain 30X
//  - Programa IA para Abogados | EstadoX
export const PROGRAM_EVENT_TYPES = () => {
  const fromEnv = (process.env.CALENDLY_EVENT_TYPES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv.length) return fromEnv;
  return [
    'https://api.calendly.com/event_types/56efc028-ee2f-46e8-852c-e50d45b15b83',
    'https://api.calendly.com/event_types/f8d123ac-364b-47f9-a446-1316fdf37b08',
  ];
};

// ─── HTTP con throttle propio + manejo de 429 (Retry-After) ───────────────────
// Rate limit de Calendly: 60 req/min (Standard/Teams). Limitamos a ~50/min para
// no chocar nunca, sobre todo en el arranque en frío.

const MIN_GAP_MS = Number(process.env.CALENDLY_MIN_GAP_MS || 1200);
let _lastCall = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(pathOrUrl, { retries = 3 } = {}) {
  if (!TOKEN()) throw new Error('CALENDLY_TOKEN no configurado');
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl;

  const gap = Date.now() - _lastCall;
  if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);

  for (let attempt = 0; ; attempt++) {
    _lastCall = Date.now();
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${TOKEN()}`,
        'User-Agent': 'juanito-agent/1.0',
        Accept: 'application/json',
      },
    });

    if (res.status === 429 && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
      console.warn(`[Calendly] 429 rate limit — esperando ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Calendly ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

// Lista eventos activos del grupo en una ventana, filtrando a los dos programas.
export async function listProgramEvents({ minStartIso, maxStartIso }) {
  const programs = new Set(PROGRAM_EVENT_TYPES());
  const out = [];
  const params = new URLSearchParams({
    group: GROUP_URI(),
    count: '100',
    status: 'active',
    min_start_time: minStartIso,
    max_start_time: maxStartIso,
    sort: 'start_time:asc',
  });
  let url = `${API}/scheduled_events?${params.toString()}`;
  while (url) {
    const data = await request(url);
    for (const ev of data.collection || []) {
      if (programs.has(ev.event_type)) out.push(ev);
    }
    url = data.pagination?.next_page || null;
  }
  return out;
}

export async function getEvent(eventUri) {
  const data = await request(eventUri);
  return data.resource;
}

export async function getFirstInvitee(eventUri) {
  const data = await request(`${eventUri}/invitees`);
  return (data.collection || [])[0] || null;
}

// ─── Helpers puros (sin red, sin DB) ──────────────────────────────────────────

export function firstNameFrom(fullName) {
  const n = String(fullName || '').trim().replace(/\s+/g, ' ');
  if (!n) return 'el prospecto';
  const first = n.split(' ')[0];
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// Nombre completo (limpio). Sirve para desambiguar prospectos con el mismo
// primer nombre. Respeta lo que escribió el prospecto, salvo que venga todo en
// minúsculas (entonces capitaliza cada palabra).
export function fullNameFrom(fullName) {
  const n = String(fullName || '').trim().replace(/\s+/g, ' ');
  if (!n) return 'el prospecto';
  if (n === n.toLowerCase()) {
    return n
      .split(' ')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
  return n;
}

export function closerEmailOf(ev) {
  return ev?.event_memberships?.[0]?.user_email?.toLowerCase() || null;
}

export function prospectPhoneOf(invitee) {
  const p = invitee?.text_reminder_number;
  return p && String(p).trim() ? String(p).trim() : null;
}

export function formatCallTime(startIso, tz = TZ()) {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(startIso));
}

// ─── Mensajes (plantillas fijas, sin LLM) ─────────────────────────────────────

export function buildPush3Message({ name, firstName, phone, startIso }) {
  const who = name || firstName || 'el prospecto';
  const time = formatCallTime(startIso);
  const tel = phone ? `📞 ${phone}` : '📵 sin teléfono en Calendly';
  return `🔔 *Push 3* (antes de la llamada) para *${who}* — ${tel} — llamada hoy a las ${time}`;
}

export function buildDigestMessage({ pushLabel, whenLabel, items, tz = TZ() }) {
  const sorted = [...items].sort((a, b) => new Date(a.startIso) - new Date(b.startIso));
  const lines = sorted.map((it) => {
    const who = it.name || it.firstName || 'el prospecto';
    const time = formatCallTime(it.startIso, tz);
    const tel = it.phone ? `📞 ${it.phone}` : '📵 sin teléfono';
    return `• ${time} — ${who} — ${tel}`;
  });
  const n = sorted.length;
  const plural = n === 1 ? 'llamada' : 'llamadas';
  return `📋 *${pushLabel}* — tienes ${n} ${plural} ${whenLabel}. Mándales su push precall:\n${lines.join('\n')}`;
}

// ─── Tiempo: cálculos UTC / zona horaria sin librerías ────────────────────────

export function push3DueUtc(startIso, leadMin = 25) {
  return new Date(new Date(startIso).getTime() - leadMin * 60000);
}

// 'YYYY-MM-DD HH:MM:SS' en UTC, para comparar con datetime('now') de SQLite.
export function toSqliteUtc(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// Offset de la zona (ms) en un instante dado.
function tzOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = dtf.formatToParts(date).reduce((a, x) => ((a[x.type] = x.value), a), {});
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
  return asUTC - date.getTime();
}

// Convierte una hora de pared (en tz) a un Date UTC.
function wallTimeToUtc(tz, y, mo, d, H, M) {
  const guess = Date.UTC(y, mo - 1, d, H, M, 0);
  const off = tzOffsetMs(new Date(guess), tz);
  return new Date(guess - off);
}

// Partes Y/M/D de "ahora" en la zona.
function dateParts(tz, base) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(base)
    .reduce((a, x) => ((a[x.type] = x.value), a), {});
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day) };
}

// Rango UTC [min, max) de un día completo en tz. offsetDays: 0=hoy, 1=mañana.
export function dayRangeUtc(tz, offsetDays = 0, base = new Date()) {
  const { y, mo, d } = dateParts(tz, base);
  const start = wallTimeToUtc(tz, y, mo, d + offsetDays, 0, 0);
  const end = wallTimeToUtc(tz, y, mo, d + offsetDays + 1, 0, 0);
  return { minStartIso: start.toISOString(), maxStartIso: end.toISOString() };
}
