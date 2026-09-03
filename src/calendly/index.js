// src/calendly/index.js
// Cliente de la API v2 de Calendly + helpers PUROS (sin dependencias nativas:
// no importa la DB, así que se puede testear sin compilar better-sqlite3).
//
// Hallazgos de la validación contra la cuenta real:
//  - El WAF de Calendly rechaza el User-Agent por defecto de algunos clientes →
//    enviamos un User-Agent explícito.
//  - El teléfono del prospecto vive en invitee.text_reminder_number. Puede ser null en
//    reservas instant_book / reagendadas. ⚠️ CORREGIDO 2026-08-26: acá decía que
//    questions_and_answers "viene vacío", y era cierto cuando se midió, pero dejó de serlo
//    en cuanto una empresa agrega una pregunta de teléfono al formulario. Ver prospectPhoneOf.
//  - invitee.first_name viene null → parseamos el primer nombre de invitee.name.

import { fetchConDeadline } from '../common/http.js';

const API = 'https://api.calendly.com';

const TOKEN = () => process.env.CALENDLY_TOKEN || '';
const TZ = () => process.env.TZ || 'America/Bogota';

// Los event_types, las organizaciones y los tokens viven en el REGISTRO DE CUENTAS
// (accounts.js): desde que hay más de una cuenta de Calendly, ese tuple dejó de ser un
// singleton. Acá solo se derivan las vistas que el resto del código ya consumía.
import { eventTypeToProgram, accountOf, DEFAULT_ACCOUNT } from './accounts.js';
// El copy (pitch, materiales) y los rótulos de cada programa viven en el registro PROGRAMS
// (programs.js), del que se derivan. Se importan acá para armar los mensajes y se re-exportan
// más abajo para no romper importadores del surface viejo.
import { PROGRAM_LABELS, PROGRAM_PITCH, MATERIAL_LINKS } from './programs.js';

// Organización de la cuenta por default. Se conserva para callers viejos (scripts);
// el poll usa la org de cada cuenta del registro.
export const ORG_URI = () => accountOf(DEFAULT_ACCOUNT).orgUri();

// event_types de TODOS los programas gestionados, de TODAS las cuentas.
// El override por env sigue existiendo, pero OJO: REEMPLAZA la lista entera (no suma) y
// no distingue cuentas → solo sirve para acotar pruebas contra una cuenta.
export const PROGRAM_EVENT_TYPES = () => {
  const fromEnv = (process.env.CALENDLY_EVENT_TYPES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv.length) return fromEnv;
  return Object.keys(eventTypeToProgram());
};

// ─── Producto (programa) por evento ───────────────────────────────────────────
// Cada reserva pertenece a un producto. El copy del push precall difiere por producto
// (intro + nombre del programa), así que necesitamos saber cuál es para elegir la
// plantilla correcta — POR LLAMADA, porque un mismo closer puede tener citas de varios
// productos en un mismo digest.
//
// Acepta el event_type (string) o el evento completo. Devuelve la clave de
// programa | null (null si el event_type no es de los productos conocidos).
export function programKeyOf(eventTypeOrEvent) {
  const et =
    typeof eventTypeOrEvent === 'string' ? eventTypeOrEvent : eventTypeOrEvent?.event_type;
  return eventTypeToProgram()[et] || null;
}

// Link de la llamada (Push 3): Calendly guarda el join_url del conferencing en
// event.location. Puede venir vacío en ubicaciones físicas/custom.
export function eventJoinUrl(ev) {
  const loc = ev?.location;
  if (!loc) return '';
  if (loc.join_url) return loc.join_url;
  if (typeof loc.location === 'string') return loc.location;
  return '';
}

// ─── HTTP con throttle propio + manejo de 429 (Retry-After) ───────────────────
// Rate limit de Calendly: 60 req/min (Standard/Teams). Limitamos a ~50/min para
// no chocar nunca, sobre todo en el arranque en frío.

const MIN_GAP_MS = Number(process.env.CALENDLY_MIN_GAP_MS || 1200);
let _lastCall = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `token`: el de la cuenta dueña del recurso. Sin él cae al de la cuenta default, que
// es el comportamiento histórico (y lo que usan los scripts de inspección).
async function request(pathOrUrl, { retries = 3, token } = {}) {
  const bearer = token || TOKEN();
  if (!bearer) throw new Error('CALENDLY_TOKEN no configurado');
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl;

  const gap = Date.now() - _lastCall;
  if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);

  for (let attempt = 0; ; attempt++) {
    _lastCall = Date.now();
    const res = await fetchConDeadline(url, {
      headers: {
        Authorization: `Bearer ${bearer}`,
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

// Lista eventos activos de la ORGANIZACIÓN de UNA cuenta en una ventana, filtrando a los
// programas de ESA cuenta. Org-wide (no por grupo) porque los closers de LinkedIn Sales no
// están en ningún grupo de Calendly; el filtro por event_type acota a nuestros productos.
//
// `account` = entrada del registro (accounts.js). Sin ella cae a la cuenta default, que es
// el comportamiento histórico. El filtro usa los ETs de ESA cuenta, no la lista global:
// una cuenta nunca debe agendar pushes de citas de otra.
export async function listProgramEvents({ minStartIso, maxStartIso, account }) {
  const acct = account || accountOf(DEFAULT_ACCOUNT);
  const fromEnv = (process.env.CALENDLY_EVENT_TYPES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const programs = new Set(fromEnv.length ? fromEnv : Object.keys(acct.eventTypes));
  const out = [];
  const params = new URLSearchParams({
    organization: acct.orgUri(),
    count: '100',
    status: 'active',
    min_start_time: minStartIso,
    max_start_time: maxStartIso,
    sort: 'start_time:asc',
  });
  let url = `${API}/scheduled_events?${params.toString()}`;
  while (url) {
    const data = await request(url, { token: acct.token() });
    for (const ev of data.collection || []) {
      if (programs.has(ev.event_type)) out.push(ev);
    }
    url = data.pagination?.next_page || null;
  }
  return out;
}

export async function getEvent(eventUri, { token } = {}) {
  const data = await request(eventUri, { token });
  return data.resource;
}

// Fix #3: un fallo transitorio (red/rate-limit) dejaba el push sin nombre ni
// teléfono del prospecto — justo el dato que el closer necesita para pushear.
// Un reintento con backoff corto reduce esas líneas que caían a "el prospecto".
export async function getFirstInvitee(eventUri, { token } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await request(`${eventUri}/invitees`, { token });
      return (data.collection || [])[0] || null;
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await sleep(500);
    }
  }
  throw lastErr;
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

// ─── Teléfono del prospecto ───────────────────────────────────────────────────
// DOS fuentes, en orden. `text_reminder_number` es la nativa de Calendly (la casilla de
// recordatorios por SMS) y sigue siendo la primera. La segunda es una PREGUNTA del formulario,
// y no es un caso de borde: Tactical Investor (25-ago) y ComunicArte (26-ago) —los dos
// programas de Retia— agregaron una pregunta
// obligatoria de teléfono y NO prendieron la casilla nativa ⇒ desde ese corte el número llega
// solo por ahí. Medido el 2026-08-26: 4 de 4 reservas nuevas de ComunicArte y las 3 nuevas de
// Retia. Sin esto, esas dos conexiones —las únicas con `hubspot:false`, o sea SIN el rescate
// por CRM que tapa el hueco en 30X— degradan todos sus pushes a "(mándalo manual)".
//
// Se exige que coincidan LAS DOS cosas: que la pregunta hable de un teléfono y que la
// respuesta tenga forma de teléfono.
//
//  · Por la PREGUNTA y no solo por la forma, porque una respuesta numérica cualquiera
//    ("¿cuánto facturas al mes?" → "8000000") pasaría el filtro de forma y terminaría en un
//    link wa.me hacia un número que no existe, o peor, hacia un desconocido. Un falso negativo
//    nos deja como hoy; un falso positivo manda un mensaje mal dirigido.
//  · Por la FORMA y no solo por la pregunta, porque el campo es texto libre: "no tengo" o
//    "el mismo del correo" son respuestas reales a una pregunta de teléfono.
//
// El match de la pregunta va normalizado (sin acentos, sin mayúsculas, sin puntuación) porque
// los dos programas ya la escribieron distinto: "Ingrese su número telefonico:" en Tactical Investor e
// "Ingrese su número telefónico" en ComunicArte. Cablear el texto exacto sería cablear el typo.
const sinAcentos = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

// Palabras que delatan una pregunta de teléfono, en los dos idiomas en los que Calendly arma
// estos formularios. Agregar una es sumar un término acá, nada más.
//
// Van como RAÍZ, no como palabra completa: la pregunta real de Tactical Investor dice "telefonico", y
// 'telefono' no es substring de 'telefonico' (la 8ª letra es i, no o). Ese detalle tonto costó
// el primer intento de este arreglo — de ahí el test con los dos textos de producción.
const PREGUNTA_TELEFONO = ['telefon', 'tel.', 'celular', 'movil', 'whatsapp', 'wpp', 'phone', 'mobile'];

// ¿Esto tiene forma de número marcable? 7 a 15 dígitos (el rango de E.164, que cubre desde un
// fijo local hasta el internacional más largo) y ningún carácter fuera de dígitos, '+' y los
// separadores de siempre. Las letras lo descartan: eso es una frase, no un número.
function pareceTelefono(valor) {
  const t = String(valor || '').trim();
  if (!t || !/^\+?[\d\s().-]+$/.test(t)) return false;
  const digitos = t.replace(/\D/g, '');
  return digitos.length >= 7 && digitos.length <= 15;
}

export function prospectPhoneOf(invitee) {
  const p = invitee?.text_reminder_number;
  if (p && String(p).trim()) return String(p).trim();
  for (const qa of invitee?.questions_and_answers || []) {
    const pregunta = sinAcentos(qa?.question);
    if (!PREGUNTA_TELEFONO.some((k) => pregunta.includes(k))) continue;
    if (pareceTelefono(qa?.answer)) return String(qa.answer).trim();
  }
  return null;
}

export function formatCallTime(startIso, tz = TZ()) {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(startIso));
}

// Hora limpia para los mensajes que el lead recibe ("6:57 pm"): sin cero a la
// izquierda y sin el "p. m." con punto final del formato es-CO (evita el doble
// punto cuando la plantilla cierra la frase con punto).
export function formatLeadTime(startIso, tz = TZ()) {
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(startIso));
  return s.replace(/\s*AM$/, ' am').replace(/\s*PM$/, ' pm');
}

// ─── Copy precall: el texto que el CLOSER le envía al LEAD ─────────────────────
// IMPORTANTE: este texto NO lo manda Juanito. Va dentro de un link wa.me; el closer
// lo toca, se le abre el chat del lead con el mensaje ya escrito y solo presiona
// enviar. El que envía es el closer → cero riesgo de ban para Juanito.
//
// Son 2 productos × 3 pushes = 6 variantes. El Push 2 es idéntico entre productos;
// el Push 1 cambia el intro y el nombre del programa; el Push 3 solo cambia por el
// link de la llamada (se inyecta por cita).

// Los links de materiales (MATERIAL_LINKS) y los rótulos cortos (PROGRAM_LABELS) de cada
// programa se derivan del registro PROGRAMS (programs.js) — editá un programa AHÍ, no acá.
// Se re-exportan para no romper importadores del surface viejo (antes eran `export const`
// en este archivo). PROGRAM_LABELS es distinta de PROGRAM_PITCH.program (la frase larga que
// ve el LEAD): PROGRAM_LABELS es el rótulo interno que segmenta los mensajes al CLOSER.
export { PROGRAM_LABELS, MATERIAL_LINKS };

// Rótulo del programa para los headers/líneas al closer. Devuelve '' si el programa es
// desconocido (así el mensaje no muestra un tag vacío ni una clave cruda).
export function programLabelOf(programKey) {
  return PROGRAM_LABELS[programKey] || '';
}

// Flags por-programa que se leen de `materials` (programs.js), junto a los links:
//   · `order`      — orden de las líneas (default brochure→video; tactical_investor pide video 1º)
//   · `sendLinks`  — en `false`, el programa CONSERVA sus URLs en el registro pero NO las manda
//                    en el push. El encabezado SÍ se mantiene: el material lo entrega el closer
//                    por su cuenta (operaciones, 2026-07-28). Ojo con la diferencia respecto a
//                    "no tiene links": ahí el bloque entero se omite (ver abajo).
//   · `boldHeader` — encabezado en negrita de WhatsApp (`*…*`).
const MATERIALS_HEADER = 'Es MUY IMPORTANTE que puedas ver estos materiales sí o sí antes de nuestra llamada:';

function materialsBlock(programKey) {
  const links = MATERIAL_LINKS[programKey] || {};
  const labels = { brochure: '📄 Brochure', video: '🎥 Video' };
  const order = links.order || ['brochure', 'video'];
  const hideLinks = links.sendLinks === false;
  const lines = hideLinks ? [] : order.filter((kind) => links[kind]).map((kind) => `${labels[kind]}: ${links[kind]}`);
  // Sin líneas y sin haberlo pedido: el programa todavía no tiene materiales cargados → se omite
  // el bloque entero, para no mandarle al lead un "mirá estos materiales:" seguido de nada. Un
  // `sendLinks:false` explícito SÍ deja el encabezado solo — eso es una decisión, no un olvido.
  if (!lines.length && !hideLinks) return '';
  const header = links.boldHeader ? `*${MATERIALS_HEADER}*` : MATERIALS_HEADER;
  return lines.length ? `\n\n${header}\n\n${lines.join('\n')}` : `\n\n${header}`;
}

// Construye el texto precall (lo que el closer envía al lead). pushN: 1 | 2 | 3.
// Devuelve null si el programa no tiene copy propio en PROGRAM_PITCH — los callers
// degradan a "mándalo manual". NO hay fallback a otro programa: antes caía a
// second_brain, así que agregar un programa sin su copy le mandaba al lead un mensaje
// que lo invitaba al programa EQUIVOCADO (el texto viaja en el link wa.me que el closer
// toca para enviar, o sea que sale casi tal cual). Mejor sin push que con el push errado.
export function buildPrecallText({ programKey, pushN, primerNombre, closer, hora, linkLlamada = '' }) {
  const lead = primerNombre || 'hola';
  const pitch = PROGRAM_PITCH[programKey];
  if (!pitch) {
    console.warn(`[Calendly] programa "${programKey}" sin copy en PROGRAM_PITCH → push precall omitido`);
    return null;
  }

  if (pushN === 1) {
    return (
      `Hola ${lead}, cómo va todo? Por acá ${closer} ${pitch.from}.\n\n` +
      `Quería personalmente recordarte tu llamada de mañana a las ${hora}, hora Colombia, para tu postulación al ${pitch.program}.\n\n` +
      `Muy importante que:\n` +
      `* Puedas prender la cámara\n` +
      `* Estés en un espacio dispuesto para conversar\n` +
      `* Si debes tomar la decisión con alguien más de ingresar al programa, que esa persona esté contigo en la llamada.\n\n` +
      `Si todo sale bien, ahí mismo formalizaremos tu ingreso al programa.` +
      // Solo AI Second Brain: pedimos confirmar que puede instalar Claude en su compu de trabajo.
      (programKey === 'second_brain'
        ? `\n\nUna última cosa: confírmame porfa si en el computador que usas en el día a día puedes instalar la herramienta de inteligencia artificial Claude o si tienes alguna restricción de tu compañía.`
        : '') +
      materialsBlock(programKey)
    );
  }

  if (pushN === 2) {
    return (
      `Buenos días ${lead}, feliz mañana!\n\n` +
      `Recuerda que nos vemos hoy a las ${hora}. Súper importante que antes de nuestra llamada tengas clara la información del material que te dejé anoche.\n\n` +
      `Si tienes alguna pregunta sobre la info de este material, házmela saber`
    );
  }

  // pushN === 3. Sin link: pasa en las reagendas por fuera de Calendly (§18.AC), donde
  // el link lo coordinó el closer con el lead y Juanito no lo tiene.
  if (!linkLlamada) return `Ya casi nos vemos ${lead}, nos conectamos por el link que ya te compartí.`;
  return `Ya casi nos vemos ${lead}, te dejo a la mano el link de la llamada:\n${linkLlamada}`;
}

// Link wa.me con el mensaje ya escrito. El closer lo toca → chat del lead listo.
// Normaliza el teléfono a dígitos E.164 sin `+`. Devuelve null si no hay teléfono
// o si no hay texto (programa sin copy → buildPrecallText devuelve null; sin esta
// guarda, encodeURIComponent(null) mandaba al lead un chat con la palabra "null").
export function buildLeadLink(phone, text) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits || !text) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

// ─── Mensajes que recibe el CLOSER (Juanito → closer) ─────────────────────────
// Cada uno incrusta el link wa.me con el push precall listo para el lead.

export function buildPush3Message({ name, firstName, phone, startIso, programKey, closer, linkLlamada = '' }) {
  const who = name || firstName || 'el prospecto';
  const time = formatCallTime(startIso);
  const tel = phone ? `📞 ${phone}` : '📵 sin teléfono en Calendly';
  const label = programLabelOf(programKey);
  const prog = label ? ` — 📦 *${label}*` : '';
  const head = `🔔 *Push 3* (antes de la llamada) para *${who}*${prog} — ${tel} — llamada hoy a las ${time}`;
  if (!phone) return `${head}\n(sin teléfono en Calendly — mándalo manual)`;
  const text = buildPrecallText({
    programKey,
    pushN: 3,
    primerNombre: firstName || firstNameFrom(name),
    closer,
    hora: formatLeadTime(startIso),
    linkLlamada,
  });
  const link = buildLeadLink(phone, text);
  return link ? `${head}\n👉 Enviar push: ${link}` : `${head}\n(sin copy para este programa — mándalo manual)`;
}

// Push 0 (aviso de nueva call HOY): mensaje INFORMATIVO al closer — "te reservaron
// un espacio". No lleva link wa.me; el push accionable con el link llega ~25 min
// antes (Push 3). Concíso a propósito: es un heads-up, no el recordatorio precall.
// `when`: 'hoy' (default) | 'mañana'. El caso 'mañana' existe por la ventana ciega
// de la noche (ver push-logic.js): una reserva de las 9pm para el día siguiente no
// entra en ningún digest, así que este es el ÚNICO aviso que el closer recibe esa
// noche. Decir "hoy" ahí sería peor que no avisar — lo manda a la agenda equivocada.
export function buildPush0Message({ name, firstName, phone, startIso, programKey, tz = TZ(), when = 'hoy' }) {
  const who = name || firstName || 'el prospecto';
  const time = formatCallTime(startIso, tz);
  const tel = phone ? `📞 ${phone}` : '📵 sin teléfono en Calendly';
  const label = programLabelOf(programKey);
  const prog = label ? ` — 📦 *${label}*` : '';
  const esManana = when === 'mañana';
  const titulo = esManana ? 'Nueva call MAÑANA' : 'Nueva call HOY';
  const cola = esManana
    ? 'Mañana te llega el resumen del día y el push con el link ~25 min antes.'
    : 'Te llegará el push con el link ~25 min antes de la llamada.';
  return (
    `📅 *${titulo}* — te acaban de reservar un espacio en tu agenda.\n` +
    `*${who}*${prog} — ${tel} — ${when} a las ${time}\n` +
    cola
  );
}

export function buildDigestMessage({ pushLabel, whenLabel, items, pushN, closer, tz = TZ() }) {
  const sorted = [...items].sort((a, b) => new Date(a.startIso) - new Date(b.startIso));
  const renderLine = (it) => {
    const who = it.name || it.firstName || 'el prospecto';
    const time = formatCallTime(it.startIso, tz);
    const tel = it.phone ? `📞 ${it.phone}` : '📵 sin teléfono';
    const head = `• ${time} — ${who} — ${tel}`;
    if (!it.phone) return `${head} (mándalo manual)`;
    const text = buildPrecallText({
      programKey: it.programKey,
      pushN,
      primerNombre: it.firstName || firstNameFrom(it.name),
      closer,
      hora: formatLeadTime(it.startIso, tz),
    });
    const link = buildLeadLink(it.phone, text);
    return link ? `${head}\n  👉 ${link}` : `${head} (mándalo manual)`;
  };

  // Segmentación por programa: un closer con citas de dos programas necesita saber cuál es
  // cuál. Con un solo programa NO agrupamos (evita un subtítulo redundante). El orden dentro
  // de cada grupo sigue siendo por hora (sorted); los grupos salen en el orden de su 1ra cita.
  const programs = [...new Set(sorted.map((it) => it.programKey))];
  let body;
  if (programs.length > 1) {
    body = programs
      .map((pk) => {
        const label = programLabelOf(pk) || 'Sin programa';
        const lines = sorted.filter((it) => it.programKey === pk).map(renderLine);
        return `📦 *${label}*\n${lines.join('\n')}`;
      })
      .join('\n\n');
  } else {
    body = sorted.map(renderLine).join('\n');
  }

  const n = sorted.length;
  const plural = n === 1 ? 'llamada' : 'llamadas';
  return (
    `📋 *${pushLabel}* — tienes ${n} ${plural} ${whenLabel}.\n` +
    `Toca el link de cada lead para enviarle su push precall (se abre el chat con el mensaje listo, solo dale enviar):\n\n` +
    body
  );
}

// ─── Push 4 (§18.AB): registro de outcome post-call ───────────────────────────
// Después de la call, Juanito le pregunta al closer cómo le fue y guarda el estado.
// Cero fricción: el closer responde un mensaje que ya recibe, no abre ninguna hoja.
// Dos pasos: asistencia (siempre) → resultado (solo si fue Show). Respuesta por
// número o lenguaje natural ("fue show", "no llegó", "cerró"): parsers deterministas.

// Etiquetas legibles (fuente única para mensajes + reportes).
export const ASISTENCIA_LABELS = {
  show: 'Show',
  no_show: 'No show',
  reagendado: 'Reagendó',
  cancelado: 'Cancelado',
};
export const RESULTADO_LABELS = {
  venta_cerrada: 'Venta cerrada',
  acuerdo_verbal: 'Acuerdo verbal',
  seguimiento: 'Seguimiento',
  no_cerro: 'No cerró',
};

// Vencimiento del Push 4: fin de la call (start + duración) + gracia.
// Por defecto 30 min de call + 5 de gracia = start + 35 min.
export function push4DueUtc(startIso, durationMin = 30, graceMin = 5) {
  return new Date(new Date(startIso).getTime() + (durationMin + graceMin) * 60000);
}

// Normaliza texto del closer: minúsculas, sin acentos, sin emojis, espacios colapsados.
// También mapea los dígitos-emoji (1️⃣) a su número ASCII para el parse por número.
function normalizeReply(text) {
  return String(text || '')
    .replace(/1️?⃣/g, ' 1 ')
    .replace(/2️?⃣/g, ' 2 ')
    .replace(/3️?⃣/g, ' 3 ')
    .replace(/4️?⃣/g, ' 4 ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita acentos
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Primer dígito 1-4 suelto en el texto (token), o null. "1", "opcion 2", "3." → n.
function leadingChoice(norm) {
  const m = norm.match(/(?:^|\s)([1-4])(?:\s|$)/);
  return m ? Number(m[1]) : null;
}

// Interpreta la respuesta de ASISTENCIA. Devuelve clave | null (no entendí).
// El orden importa: "no show"/"no llego" contienen "show"/"llego" → la negación
// se evalúa primero. Acepta número (1-4) o lenguaje natural.
export function parseAsistenciaReply(text) {
  const n = normalizeReply(text);
  if (!n) return null;
  const choice = leadingChoice(n);
  if (choice === 1) return 'show';
  if (choice === 2) return 'no_show';
  if (choice === 3) return 'reagendado';
  if (choice === 4) return 'cancelado';
  // Lenguaje natural — negaciones y reagendado/cancelado primero. Stems SIN \b de
  // cierre (matchean prefijos: "reagende", "cancelo"); "si" va como palabra completa.
  if (/\b(reagend|reprogram|movi|cambio de fecha|cambio la fecha|otra fecha|para otro dia)/.test(n))
    return 'reagendado';
  if (/\bcancel/.test(n)) return 'cancelado';
  if (/\b(no show|noshow|no llego|no vino|no asistio|no se presento|no se conecto|falto|fantasma|ghost)/.test(n))
    return 'no_show';
  if (/\b(show|asistio|vino|llego|se conecto|se presento|estuvo)/.test(n) || /\bsi\b/.test(n)) return 'show';
  return null;
}

// Interpreta la respuesta de RESULTADO (solo aplica si fue Show). Devuelve clave | null.
// "no cerro" contiene "cerro" → la negación primero.
export function parseResultadoReply(text) {
  const n = normalizeReply(text);
  if (!n) return null;
  const choice = leadingChoice(n);
  if (choice === 1) return 'venta_cerrada';
  if (choice === 2) return 'acuerdo_verbal';
  if (choice === 3) return 'seguimiento';
  if (choice === 4) return 'no_cerro';
  if (/\b(no cerro|no se cerro|no vendi|no compro|no hubo venta|nada|frio|se cayo)/.test(n)) return 'no_cerro';
  if (/\b(venta|cerro|cerrada|cerre|vendi|vendido|compro|pago)/.test(n)) return 'venta_cerrada';
  if (/\b(acuerdo|verbal|de palabra|palabra|comprometio)/.test(n)) return 'acuerdo_verbal';
  if (/\b(seguimiento|follow|pendiente|lo va a pensar|pensarlo|pensando|despues|mas adelante)/.test(n))
    return 'seguimiento';
  return null;
}

// Mensaje del Push 4 (paso 1: asistencia). Lo recibe el closer ~5 min después de la call.
export function buildPush4Message({ name, firstName, startIso, tz = TZ() }) {
  const who = name || firstName || 'el prospecto';
  const time = formatCallTime(startIso, tz);
  return (
    `📋 *Registro de call* — *${who}* (de las ${time}).\n` +
    `¿Cómo te fue? Respóndeme con el número:\n` +
    `1️⃣ Show (asistió)\n` +
    `2️⃣ No show (no llegó)\n` +
    `3️⃣ Reagendó`
  );
}

// Paso 2: resultado (solo si la asistencia fue Show).
export function buildOutcomeFollowupMessage({ name, firstName }) {
  const who = name || firstName || 'el prospecto';
  return (
    `🙌 *${who}* asistió. ¿Cuál fue el resultado?\n` +
    `1️⃣ Venta cerrada\n` +
    `2️⃣ Acuerdo verbal\n` +
    `3️⃣ Seguimiento\n` +
    `4️⃣ No cerró`
  );
}

// Confirmación tras guardar (cierra el loop con el closer).
export function buildOutcomeConfirmation({ name, firstName, asistencia, resultado }) {
  const who = name || firstName || 'el prospecto';
  const a = ASISTENCIA_LABELS[asistencia] || asistencia || '—';
  const r = resultado ? ` / ${RESULTADO_LABELS[resultado] || resultado}` : '';
  return `✅ Registrado: *${who}* → ${a}${r}. ¡Gracias! 🙌`;
}

// ─── Reagendas (§18.AC) ───────────────────────────────────────────────────────
// Cuando el closer marca "3 · Reagendó", Juanito le pide la fecha nueva y con eso agenda
// la call reagendada por su cuenta (venga o no de Calendly). Sin la fecha, esa call sería
// invisible para las métricas — y la original se contaría igual, inflando el volumen.

export function buildRescheduleAskMessage({ name, firstName }) {
  const who = name || firstName || 'el prospecto';
  return (
    `🔁 Listo, *${who}* quedó reagendado. ¿Para cuándo?\n` +
    `Escríbeme la fecha y la hora — ej: *hoy 3pm* · *mañana 10:30am* · *22/07 9am*.\n` +
    `Si aún no hay fecha, dime "aún no sé" y te lo pregunto mañana.`
  );
}

// Confirmación con ECHO de la fecha resuelta: es la red de seguridad del parser. Si Juanito
// entendió mal, el closer lo ve acá mismo y lo corrige en el hilo.
export function buildRescheduleConfirmation({ name, firstName, startIso, tz = TZ() }) {
  const who = name || firstName || 'el prospecto';
  const cuando = formatCallDateTime(startIso, tz);
  return (
    `✅ Anotado: *${who}* → *${cuando}*.\n` +
    `Te escribo antes de esa call y te pregunto cómo te fue. No tienes que hacer nada más 🙌`
  );
}

export function buildRescheduleSinFechaMessage({ name, firstName }) {
  const who = name || firstName || 'el prospecto';
  return `✅ Anotado: *${who}* reagendó (sin fecha aún). Te pregunto mañana. Si la agenda entra por Calendly, la tomo solo.`;
}

// Insistencia diaria: reagendas que quedaron sin fecha.
export function buildReschedulePromptMessage({ name, firstName }) {
  const who = name || firstName || 'el prospecto';
  return (
    `🔁 ¿Ya quedó fecha con *${who}*?\n` +
    `Escríbemela — ej: *hoy 3pm* · *mañana 10:30am* · *22/07 9am*.`
  );
}

// Repregunta cuando no se entendió la fecha (o la que dio no sirve).
export function buildRescheduleReprompt({ name, firstName, reason }) {
  const who = name || firstName || 'el prospecto';
  if (reason === 'past')
    return `🤔 Esa fecha ya pasó. ¿Para cuándo quedó *${who}*? Ej: *hoy 3pm* · *mañana 10:30am*.`;
  if (reason === 'far')
    return `🤔 Esa fecha está muy lejos (más de 3 meses). ¿Para cuándo quedó *${who}*?`;
  return (
    `🙈 No te entendí la fecha de *${who}*.\n` +
    `Escríbela así: *hoy 3pm* · *mañana 10:30am* · *22/07 9am*. O dime "aún no sé".`
  );
}

// Fecha + hora legibles ("mar 22 jul, 3:00 pm") — para el echo de confirmación.
export function formatCallDateTime(startIso, tz = TZ()) {
  const fecha = new Intl.DateTimeFormat('es-CO', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(startIso));
  return `${fecha}, ${formatLeadTime(startIso, tz)}`;
}

// Recordatorio (insistencia v1): si no respondió el Push 4 en ~30 min.
export function buildOutcomeReminder({ name, firstName, startIso, tz = TZ() }) {
  const who = name || firstName || 'el prospecto';
  const time = formatCallTime(startIso, tz);
  return (
    `👀 Recordatorio rápido: aún no me dijiste cómo te fue la call con *${who}* de las ${time}.\n` +
    `Respóndeme: 1️⃣ Show · 2️⃣ No show · 3️⃣ Reagendó`
  );
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

// ─── Soporte Push 0 (§18.C): "¿es hoy?" y "¿ya corrió el Push 2?" ─────────────

// ¿El instante `iso` cae el MISMO día que `base`, en la zona `tz`? (Comparación
// por componentes de pared y/mo/d, no por UTC — un evento de las 11pm Bogotá es
// "hoy" aunque en UTC ya sea mañana.)
export function isSameDayInTz(iso, tz = TZ(), base = new Date()) {
  const a = dateParts(tz, new Date(iso));
  const b = dateParts(tz, base);
  return a.y === b.y && a.mo === b.mo && a.d === b.d;
}

// ¿El instante `iso` cae MAÑANA respecto de `base`, en la zona `tz`? Mismo criterio
// de día de pared que isSameDayInTz. Lo usa el Push 0 para tapar la ventana ciega
// de la noche (ver el comentario largo en push-logic.js).
export function isNextDayInTz(iso, tz = TZ(), base = new Date()) {
  const { minStartIso, maxStartIso } = dayRangeUtc(tz, 1, base);
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= Date.parse(minStartIso) && t < Date.parse(maxStartIso);
}

// Extrae {hour, minute} de un cron diario simple ("M H * * *"). Devuelve null si
// no es un cron diario de hora fija (no intentamos parsear expresiones complejas).
export function parseDailyCronHM(cron) {
  const parts = String(cron || '').trim().split(/\s+/);
  if (parts.length < 5) return null;
  const [m, h, dom, mon, dow] = parts;
  if (dom !== '*' || mon !== '*' || dow !== '*') return null;
  const minute = Number(m);
  const hour = Number(h);
  if (!Number.isInteger(minute) || !Number.isInteger(hour)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

// ¿Ya pasó HOY (en tz) la hora de un cron diario? Si el cron no es un diario
// simple, devolvemos true (no bloqueamos el Push 0 por un cron exótico).
export function dailyCronHasRunToday(cron, tz = TZ(), base = new Date()) {
  const hm = parseDailyCronHM(cron);
  if (!hm) return true;
  const { y, mo, d } = dateParts(tz, base);
  const runUtc = wallTimeToUtc(tz, y, mo, d, hm.hour, hm.minute);
  return base.getTime() >= runUtc.getTime();
}

// Alias histórico: el Push 0 nació mirando solo el Push 2. Hoy la misma función
// sirve para el Push 1 (ventana ciega de la noche), de ahí el nombre genérico de
// arriba. Se conserva porque lo importan el scheduler y sus tests.
export const push2HasRunToday = dailyCronHasRunToday;
