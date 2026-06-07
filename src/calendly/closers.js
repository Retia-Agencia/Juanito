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
