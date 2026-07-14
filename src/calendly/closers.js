// src/calendly/closers.js
// Mapeo precargado: email de Calendly (host del evento) → WhatsApp del closer.
//
// Notas de la validación contra la cuenta real (grupo "Negociación"):
//  - El "organizado por" del evento (event_memberships[0].user_email) ES el closer.
//
// Para cambiar un número o un closer, editar este mapa.
//
// EQUIPO — lista dictada por el jefe el 2026-07-14 y validada contra la cuenta real de
// Calendly. Estos 7 son TODO el equipo: quien no esté acá, no se gestiona.
//
//   Pablo Lozano        AI Second Brain · AI For Developers
//   Sebastian Rodriguez AI Second Brain
//   Sebastian Marin     LinkedIn Sales  · Instagram & TikTok / Media
//   Lucas Mendoza       LinkedIn Sales  · Instagram & TikTok · Operaciones Escalables
//   Pablo Suarez        AI For Developers
//   Daniela Camacho     EstadoX (IA para Abogados) · Instagram & TikTok (ambos)
//   Sebastian Salazar   EstadoX (IA para Abogados)
//
// El PROGRAMA no se configura acá: se deriva del event_type de cada cita (programKeyOf),
// así que un closer queda cubierto en TODOS los programas sin tocar nada más. La columna
// de arriba es informativa (a qué pools pertenece hoy), no la usa el código.
export const CLOSERS = {
  'daniela.camacho@30x.com':  { name: 'Daniela Camacho',     phone: '+573103062287' },
  'sebastian@30x.com':        { name: 'Sebastian Rodriguez', phone: '+573102212005' },
  'sebastian.salazar@30x.com':{ name: 'Sebastian Salazar',   phone: '+573054312905' },
  'pablo.lozano@30x.com':     { name: 'Pablo Lozano',        phone: '+573046131437' },
  'sebastian.marin@30x.com':  { name: 'Sebastian Marin',     phone: '+573212100048' },
  'lucas.mendoza@30x.com':    { name: 'Lucas Mendoza',       phone: '+573014477044' },
  // Entró 2026-07-14. OJO: su email NO lleva punto (pablosuarez@), a diferencia de
  // pablo.lozano@ — son personas distintas y ambas están activas.
  'pablosuarez@30x.com':      { name: 'Pablo Suarez',        phone: '+573152573103' },
};

// LIDs de TRABAJO conocidos de closers cuyo número/nombre de WhatsApp NO permite el match por las
// otras vías (ej: Sebas Rodriguez escribe desde un @lid que no mapea a su teléfono canónico y su
// pushName no incluye "Rodriguez"). Mapear aquí su LID de trabajo hace que el bot lo reconozca y
// que su contact_jid se AUTOCORRIJA al hilo correcto en vez de driftear al número equivocado.
// REGLA: solo LIDs de TRABAJO confirmados. NUNCA poner un LID personal — recrearía el bug de
// pushes al número equivocado. Clave = solo los dígitos del LID (sin @lid). Valor = email del closer.
export const CLOSER_LIDS = {
  '158025419608301': 'sebastian@30x.com', // Sebastian Rodriguez (su pushName de trabajo no trae "Rodriguez")
};

// Hosts de Calendly que aparecen en el query org-wide pero que DELIBERADAMENTE NO
// gestionamos con pushes. Se saltan en SILENCIO — sin alerta de "closer sin mapear" al admin.
// Mover a CLOSERS cuando se quieran activar.
//
// Auditoría 2026-07-14 (45 días de historia + 14 de agenda futura contra la cuenta real):
// TODOS los de esta lista tienen CERO calls futuras y llevan entre 20 y 42 días sin hostear
// — están fuera del equipo o dormidos. Camilo/Natalia/registro@ estaban SIN MAPEAR (ni acá
// ni en CLOSERS), así que sus calls disparaban alertas de "closer sin mapear" en cada poll.
export const IGNORED_CLOSERS = new Set([
  // Salió del equipo (2026-07-14). No está en la lista de closers que dictó el jefe.
  // Tenía 139 calls en Second Brain pero CERO futuras y sin hostear desde el 3 jul.
  // Su opt-in también se borró de la DB — si vuelve, tiene que escribirle a Juanito de nuevo.
  'maca.celis@30x.com',
  'andrea.machado@30x.com',   // salió del equipo (2026-07-14; última call 25 jun)
  'mateo.leon@30x.com',       // salió del equipo (2026-06-24)
  'natalia.gonzalez@30x.com', // salió del equipo (2026-06-24; se documentó pero no se ignoró → alertas)
  'camilo.castiblanco@30x.com', // salió del equipo (2026-07-14; última call 8 jun)
  'dana@30x.com',             // su volumen real está en "AI for Executives" (programa no gestionado)
  'yuli@30x.com',             // idem Dana
  'equipo@estadox.com',       // cuenta compartida de EstadoX — standby
  'registro@estadox.com',     // cuenta de sistema de EstadoX — nunca fue un closer
]);

export function isIgnoredCloser(email) {
  if (!email) return false;
  return IGNORED_CLOSERS.has(String(email).toLowerCase().trim());
}

import { phonesMatch } from '../common/utils.js';

// Devuelve { name, phone } | null
export function resolveCloser(email) {
  if (!email) return null;
  return CLOSERS[String(email).toLowerCase().trim()] || null;
}

// Resuelve un closer por su número entrante (cuando le escribe a Juanito).
// Devuelve { email, name, phone } | null
export function resolveCloserByPhone(phone) {
  if (!phone) return null;
  for (const [email, c] of Object.entries(CLOSERS)) {
    if (phonesMatch(c.phone, phone)) return { email, name: c.name, phone: c.phone };
  }
  return null;
}

// Resuelve un closer por el LID desde el que escribe (CLOSER_LIDS). Para cuentas cuyo @lid no
// mapea al teléfono canónico y cuyo pushName no permite el match. Acepta el JID completo
// (158025419608301@lid) o solo los dígitos. Devuelve { email, name, phone } | null.
export function resolveCloserByLid(jid) {
  if (!jid) return null;
  const lid = String(jid).split('@')[0].replace(/\D/g, '');
  if (!lid) return null;
  const email = CLOSER_LIDS[lid];
  if (!email) return null;
  const c = CLOSERS[email];
  return c ? { email, name: c.name, phone: c.phone } : null;
}

// Devuelve el JID de TRABAJO canónico (`<lid>@lid`) de un closer si está mapeado en
// CLOSER_LIDS, o null. Sirve para PINNEAR el contact_jid de entrega al hilo de trabajo:
// aunque el closer escriba desde otro dispositivo (ej: Sebas desde su WhatsApp personal,
// cuyo pushName "Sebastian Rodriguez" SÍ matchea y haría driftear el contact_jid), la
// entrega se mantiene en el LID de trabajo. Mata el bug recurrente de "pushes al personal".
export function workLidForCloser(email) {
  if (!email) return null;
  const e = String(email).toLowerCase().trim();
  for (const [lid, mapped] of Object.entries(CLOSER_LIDS)) {
    if (mapped === e) return `${lid}@lid`;
  }
  return null;
}

// Resuelve un closer por su nombre de WhatsApp (pushName), fallback cuando el LID
// no se puede mapear a teléfono. Requiere que el pushName contenga el nombre completo
// del closer (ej: "Pablo Lozano") para evitar ambigüedades (ej: dos Sebastians).
// Devuelve { email, name, phone } | null — null si no hay match o hay ambigüedad.
// Normaliza para comparar nombres: minúsculas, SIN ACENTOS, sin emojis ni puntuación.
// Los acentos importan: en el mapa los nombres van sin tilde ("Pablo Suarez") pero el
// pushName de WhatsApp casi siempre la trae ("Pablo Suárez") → sin esto no matchean.
function nameWords(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s*\(.*\)/, '') // quita "(EstadoX)" y similares
    .replace(/[^\w\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function resolveCloserByPushName(pushName) {
  if (!pushName) return null;
  const words = nameWords(pushName);
  if (!words.length) return null;

  const seen = new Map(); // phone → entry, para deduplicar si dos emails apuntan al mismo número
  for (const [email, c] of Object.entries(CLOSERS)) {
    const closerWords = nameWords(c.name);
    // Exigir que TODAS las palabras del closer estén en el pushName (evita falsos parciales)
    if (closerWords.every(w => words.includes(w))) {
      if (!seen.has(c.phone)) seen.set(c.phone, { email, name: c.name, phone: c.phone });
    }
  }
  return seen.size === 1 ? [...seen.values()][0] : null;
}

// ¿El JID desde el que un closer se registró apunta a un número DISTINTO al canónico de
// trabajo? Es la señal del bug "pushes al número personal": el closer escribió desde otro
// número y el contact_jid del opt-in (a donde se entregan los pushes) quedó apuntando ahí.
// Solo se puede juzgar para JIDs de TELÉFONO (@s.whatsapp.net / @c.us): los @lid de
// multi-device son opacos y no mapean a un número, así que ahí devolvemos false (no alarmar).
export function isNonCanonicalOptinJid(canonicalPhone, fromJid) {
  if (!canonicalPhone || !fromJid) return false;
  if (String(fromJid).includes('@lid')) return false; // opaco: no se puede comparar con un número
  return !phonesMatch(canonicalPhone, fromJid);
}
