// src/calendly/blocklist.js
// Lista negra de teléfonos de LEADS: una cita agendada con uno de estos números no le genera
// ningún push al closer (ni el individual ni la línea del digest). Es para los trolls que
// agendan una y otra vez con datos falsos y le hacen perder la tarde al closer.
//
// PURO a propósito (sin DB ni deps nativas): se prueba en Windows y lo puede importar el
// dashboard.
//
// Dos fuentes que se SUMAN:
//   - BLOQUEADOS, acá abajo: los casos conocidos, versionados con el código.
//   - CALENDLY_BLOCKED_PHONES en el env (coma-separada): para bloquear uno nuevo en caliente
//     sin redeploy de código (igual hay que reiniciar el contenedor para que lo lea).
//
// Se compara por los ÚLTIMOS 10 DÍGITOS: el mismo número mexicano llega como "+52 871…",
// "52 1 871…" (el 1 viejo de celular), "871 518 5780" o metido en un link wa.me, y los diez
// finales son lo único que los cuatro comparten.

const BLOQUEADOS = [
  '+52 871 518 5780', // "Gerardo": agendó ~20 veces con el mismo número (2026-09)
];

const SUFIJO = 10;

const digitos = (s) => String(s || '').replace(/\D/g, '');

export function claveTelefono(phone) {
  const d = digitos(phone);
  return d.length >= SUFIJO ? d.slice(-SUFIJO) : null;
}

function clavesBloqueadas() {
  const env = String(process.env.CALENDLY_BLOCKED_PHONES || '').split(',');
  return new Set([...BLOQUEADOS, ...env].map(claveTelefono).filter(Boolean));
}

// ¿Este teléfono está en la lista negra? Un número corto o vacío nunca lo está.
export function isBlockedPhone(phone) {
  const k = claveTelefono(phone);
  return !!k && clavesBloqueadas().has(k);
}

// ¿Alguno de estos teléfonos está bloqueado? Para la cita que trae dos números (Calendly +
// formulario, §18.CA): con que uno sea del troll alcanza.
export const anyBlockedPhone = (phones = []) => phones.some(isBlockedPhone);

// ¿El texto de un push ya armado menciona un número bloqueado? La fila de `calendly_pushes`
// guarda un solo `prospect_phone`, pero el mensaje puede llevar el alterno del formulario
// (en claro y en el link wa.me). Se quitan los separadores típicos de un teléfono y se mira
// cada tira de dígitos: pegar TODOS los dígitos del mensaje juntaría la hora con el número.
export function mentionsBlockedPhone(text) {
  const tiras = String(text || '').replace(/[\s().+-]/g, '').match(/\d{10,}/g) || [];
  if (!tiras.length) return false;
  const claves = clavesBloqueadas();
  return tiras.some((t) => [...claves].some((k) => t.includes(k)));
}
