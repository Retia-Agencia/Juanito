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

// Grupo formal "Negociación" (legacy). Ya NO se usa para el query: el equipo de
// LinkedIn Sales no pertenece a ningún grupo de Calendly, así que la consulta pasó a
// ser a nivel ORGANIZACIÓN (ver ORG_URI + listProgramEvents). Se conserva por referencia.
export const GROUP_URI = () =>
  process.env.CALENDLY_GROUP_URI ||
  'https://api.calendly.com/groups/61f57776-40d4-4feb-bdbc-654f397ba0c6';

// Organización (cuenta real) — alcance del query de eventos. Org-wide captura a TODOS los
// closers de los programas, sin importar a qué grupo de Calendly pertenezcan (los de
// LinkedIn Sales no están en ninguno). Se filtra por event_type del lado del cliente.
export const ORG_URI = () =>
  process.env.CALENDLY_ORG_URI ||
  'https://api.calendly.com/organizations/9ac5ab82-0c41-43c8-bede-cc9787043b28';

// event_types de los programas gestionados (resueltos contra la cuenta real).
// Auditoría 2026-07-14: la lista de programas la dicta el jefe; estos son sus event_types.
//  - Postulación Implementación AI Second Brain 30X
//  - Postulación Programa IA para Abogados | EstadoX
//  - Postulación LinkedIn Sales 30X
//  - Postulación AI for Developers 30X          (agregado 2026-07-14)
//  - Postulación Operaciones Escalables con AI 30X (agregado 2026-07-14)
//  - Postulación Instagram & TikTok for Business 30X (agregado 2026-07-16)
//
// Los event_types tipo pool NO se pueden enumerar por la API (el query de /event_types
// org-wide solo devuelve los `kind=solo`). Se resuelven mirando el `event_type` de las
// reservas reales en /scheduled_events — así se resolvió el de Instagram el 2026-07-16,
// cuando el programa ya tenía 11 llamadas agendadas. Mismo método si aparece otro.
//
// El segundo programa de Instagram ("/Media") que se anticipaba NO existe: al 2026-07-16
// hay un único event_type de Instagram & TikTok en la cuenta. Si lanza, se agrega acá.
const SECOND_BRAIN_ET = 'https://api.calendly.com/event_types/56efc028-ee2f-46e8-852c-e50d45b15b83';
const ABOGADOS_ET = 'https://api.calendly.com/event_types/f8d123ac-364b-47f9-a446-1316fdf37b08';
const LINKEDIN_ET = 'https://api.calendly.com/event_types/96ddf036-9174-459c-be73-b248ad95be13';
const DEVELOPERS_ET = 'https://api.calendly.com/event_types/dff3e48a-4859-417a-98fb-822048aef5d9';
const OPERACIONES_ET = 'https://api.calendly.com/event_types/8462e92a-8210-4bb2-8e2b-583aa3c3d877';
const INSTAGRAM_ET = 'https://api.calendly.com/event_types/d33075cb-d349-43ef-be43-6f80f9c5da03';

export const PROGRAM_EVENT_TYPES = () => {
  const fromEnv = (process.env.CALENDLY_EVENT_TYPES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv.length) return fromEnv;
  return [SECOND_BRAIN_ET, ABOGADOS_ET, LINKEDIN_ET, DEVELOPERS_ET, OPERACIONES_ET, INSTAGRAM_ET];
};

// ─── Producto (programa) por evento ───────────────────────────────────────────
// Cada reserva pertenece a uno de los tres productos. El copy del push precall
// difiere por producto (intro + nombre del programa), así que necesitamos saber
// cuál es para elegir la plantilla correcta — POR LLAMADA, porque un mismo closer
// puede tener citas de varios productos en un mismo digest.
const PROGRAMS = {
  [SECOND_BRAIN_ET]: 'second_brain',
  [ABOGADOS_ET]: 'abogados',
  [LINKEDIN_ET]: 'linkedin',
  [DEVELOPERS_ET]: 'developers',
  [OPERACIONES_ET]: 'operaciones',
  [INSTAGRAM_ET]: 'instagram',
};

// Acepta el event_type (string) o el evento completo. Devuelve la clave de
// programa | null (null si el event_type no es de los productos conocidos).
export function programKeyOf(eventTypeOrEvent) {
  const et =
    typeof eventTypeOrEvent === 'string' ? eventTypeOrEvent : eventTypeOrEvent?.event_type;
  return PROGRAMS[et] || null;
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

// Lista eventos activos de la ORGANIZACIÓN en una ventana, filtrando a los programas
// conocidos. Org-wide (no por grupo) porque los closers de LinkedIn Sales no están en
// ningún grupo de Calendly; el filtro por event_type acota a nuestros productos.
export async function listProgramEvents({ minStartIso, maxStartIso }) {
  const programs = new Set(PROGRAM_EVENT_TYPES());
  const out = [];
  const params = new URLSearchParams({
    organization: ORG_URI(),
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

// Fix #3: un fallo transitorio (red/rate-limit) dejaba el push sin nombre ni
// teléfono del prospecto — justo el dato que el closer necesita para pushear.
// Un reintento con backoff corto reduce esas líneas que caían a "el prospecto".
export async function getFirstInvitee(eventUri) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await request(`${eventUri}/invitees`);
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

// ▼▼▼ EDITA AQUÍ: links de materiales por producto (los entrega el owner). ▼▼▼
// Mientras estén vacíos, el bloque de materiales se OMITE solo (no se manda link roto).
// Brochures: pueden ser un HTML auto-contenido en GitHub Pages (repo público
// Agencia-Dani/juanito-brochures, p. ej. abogados) o un archivo en Google Drive
// (p. ej. second_brain). Ambos abren renderizados en celular y compu al dar
// click. Videos: YouTube.
export const MATERIAL_LINKS = {
  second_brain: {
    brochure: 'https://drive.google.com/file/d/1ucwv-ANi7J7u6sXwAC4Azuj7qtI3kX_P/view',
    video: 'https://www.youtube.com/watch?v=DGA0nf0geN0',
  },
  abogados: {
    brochure: 'https://drive.google.com/file/d/1TN5HfX7r8ViM2JXuOmFOnvBSI3xyeLwR/view',
    video: 'https://www.youtube.com/watch?v=88W1z_M9tCg',
  },
  linkedin: {
    brochure: 'https://drive.google.com/file/d/1MO5jP7rnbWKUyDWao3Q1-vfF1fzR-h3O/view',
    video: 'https://youtu.be/J9LDlmtQeHs',
  },
  // Programas nuevos (2026-07-14). Todavía SIN video: el bloque de materiales se arma
  // igual, solo con el brochure (materialsBlock omite la línea que falte).
  developers: {
    brochure: 'https://drive.google.com/file/d/1VEUK_yF1UxwrkiCQJP1VHFW-nG9d426I/view',
  },
  // Operaciones NO lleva `brochure`: su deck viaja como PDF ADJUNTO, no como link
  // (ver BROCHURE_FILES abajo). `attachedBrochure` hace que el bloque de materiales
  // diga "te lo acabo de enviar" en vez de omitirse: sin eso el lead recibiría un PDF
  // suelto del closer y un mensaje que jamás lo menciona.
  operaciones: {
    attachedBrochure: true,
  },
  // Instagram & TikTok (2026-07-16). El video es una landing de 30x.com, no YouTube.
  instagram: {
    brochure: 'https://drive.google.com/file/d/1VvP9kCMldKaVs3wwXHLZFk7I6Spu-JZS/view',
    video: 'https://30x.com/instagram-tiktok',
  },
};
// ▲▲▲ EDITA AQUÍ ▲▲▲

// Brochures que Juanito ADJUNTA (documento WhatsApp) al closer en el Push 1, en vez de
// mandarle un link al lead. El closer reenvía el PDF y luego toca el link wa.me.
//
// Por qué: el copy precall viaja dentro de un `wa.me?text=`, que SOLO transporta texto —
// no admite adjuntos. Y el que envía al lead tiene que seguir siendo el closer (Juanito
// nunca escribe en frío a un lead: es la regla anti-ban). Así que el único camino para
// que el lead reciba un PDF real es que Juanito se lo pase al closer y el closer reenvíe.
//
// Costo asumido: el reenvío es manual y no verificable — si el closer no reenvía, el lead
// se queda sin material (para estos programas NO hay link de respaldo en el copy).
// Rutas relativas a la raíz del repo; los archivos entran en la imagen Docker.
export const BROCHURE_FILES = {
  operaciones: {
    path: 'assets/brochures/operaciones.pdf',
    fileName: 'Brochure Operaciones Escalables con IA 30X.pdf',
  },
};

const PROGRAM_PITCH = {
  second_brain: {
    from: 'de Andrés Bilbao en 30X',
    program:
      'programa de implementación de tecnología AI Second Brain para ti y tus proyectos',
  },
  abogados: {
    from: 'de EstadoX',
    program: 'programa de IA para Abogados de EstadoX',
  },
  linkedin: {
    from: 'de 30X',
    program: 'programa de LinkedIn Sales de 30X',
  },
  developers: {
    from: 'de 30X',
    program: 'programa de AI for Developers de 30X',
  },
  operaciones: {
    from: 'de 30X',
    program: 'programa de Operaciones Escalables con AI de 30X',
  },
  instagram: {
    from: 'de 30X',
    program: 'programa de Instagram & TikTok for Business de 30X',
  },
};

function materialsBlock(programKey) {
  const links = MATERIAL_LINKS[programKey] || {};
  const lines = [];
  // El brochure adjunto (Operaciones) no tiene link: el closer se lo reenvía al lead
  // justo antes de este mensaje, así que lo referenciamos como "acá arriba".
  if (links.attachedBrochure) lines.push('📄 Brochure: te lo acabo de enviar acá arriba 👆');
  else if (links.brochure) lines.push(`📄 Brochure: ${links.brochure}`);
  if (links.video) lines.push(`🎥 Video: ${links.video}`);
  if (!lines.length) return ''; // sin links → no incluimos el bloque
  return `\n\nEs MUY IMPORTANTE que puedas ver estos materiales sí o sí antes de nuestra llamada:\n\n${lines.join('\n')}`;
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
  const head = `🔔 *Push 3* (antes de la llamada) para *${who}* — ${tel} — llamada hoy a las ${time}`;
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
export function buildPush0Message({ name, firstName, phone, startIso, tz = TZ() }) {
  const who = name || firstName || 'el prospecto';
  const time = formatCallTime(startIso, tz);
  const tel = phone ? `📞 ${phone}` : '📵 sin teléfono en Calendly';
  return (
    `📅 *Nueva call HOY* — te acaban de reservar un espacio en tu agenda.\n` +
    `*${who}* — ${tel} — hoy a las ${time}\n` +
    `Te llegará el push con el link ~25 min antes de la llamada.`
  );
}

export function buildDigestMessage({ pushLabel, whenLabel, items, pushN, closer, tz = TZ() }) {
  const sorted = [...items].sort((a, b) => new Date(a.startIso) - new Date(b.startIso));
  const lines = sorted.map((it) => {
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
  });
  const n = sorted.length;
  const plural = n === 1 ? 'llamada' : 'llamadas';
  return (
    `📋 *${pushLabel}* — tienes ${n} ${plural} ${whenLabel}.\n` +
    `Toca el link de cada lead para enviarle su push precall (se abre el chat con el mensaje listo, solo dale enviar):\n\n` +
    lines.join('\n')
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

// ¿Ya pasó la hora del Push 2 de HOY (en tz), según su cron? Si el cron no es un
// diario simple, devolvemos true (no bloqueamos el Push 0 por un cron exótico).
export function push2HasRunToday(cron, tz = TZ(), base = new Date()) {
  const hm = parseDailyCronHM(cron);
  if (!hm) return true;
  const { y, mo, d } = dateParts(tz, base);
  const push2Utc = wallTimeToUtc(tz, y, mo, d, hm.hour, hm.minute);
  return base.getTime() >= push2Utc.getTime();
}
