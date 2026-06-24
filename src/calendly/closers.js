// src/calendly/closers.js
// Mapeo precargado: email de Calendly (host del evento) → WhatsApp del closer.
//
// Notas de la validación contra la cuenta real (grupo "Negociación"):
//  - El "organizado por" del evento (event_memberships[0].user_email) ES el closer.
//  - La cuenta compartida "Equipo EstadoX" (equipo@estadox.com) la maneja Mateo
//    Leon → se enruta a su mismo número.
//
// Para cambiar un número, editar este mapa (8 entradas, estables).

export const CLOSERS = {
  'daniela.camacho@30x.com':  { name: 'Daniela Camacho',     phone: '+573103062287' },
  'mateo.leon@30x.com':       { name: 'Mateo Leon',          phone: '+573003558574' },
  'equipo@estadox.com':       { name: 'Mateo Leon (EstadoX)', phone: '+573003558574' },
  'natalia.gonzalez@30x.com': { name: 'Natalia Gonzalez',    phone: '+573124889508' },
  'sebastian@30x.com':        { name: 'Sebastian Rodriguez', phone: '+573102212005' },
  'sebastian.salazar@30x.com':{ name: 'Sebastian Salazar',   phone: '+573054312905' },
  'pablo.lozano@30x.com':     { name: 'Pablo Lozano',        phone: '+573046131437' },
  'maca.celis@30x.com':       { name: 'Maca Celis',          phone: '+573246345899' },
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

// Resuelve un closer por su nombre de WhatsApp (pushName), fallback cuando el LID
// no se puede mapear a teléfono. Requiere que el pushName contenga el nombre completo
// del closer (ej: "Pablo Lozano") para evitar ambigüedades (ej: dos Sebastians).
// Devuelve { email, name, phone } | null — null si no hay match o hay ambigüedad.
export function resolveCloserByPushName(pushName) {
  if (!pushName) return null;
  // Quitar emojis/puntuación, lowercase, palabras
  const words = pushName.toLowerCase().replace(/[^\w\s]/g, '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;

  const seen = new Map(); // phone → entry, para deduplicar (ej: Mateo Leon / Equipo EstadoX)
  for (const [email, c] of Object.entries(CLOSERS)) {
    // Normalizar nombre del closer: quitar "(EstadoX)" y similares
    const closerWords = c.name.toLowerCase().replace(/\s*\(.*\)/, '').trim().split(/\s+/).filter(Boolean);
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
