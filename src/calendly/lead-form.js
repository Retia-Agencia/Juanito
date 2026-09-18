// src/calendly/lead-form.js
// El FORMULARIO DEL ANUNCIO como SEGUNDA fuente del teléfono del lead (§18.CA).
// Hoy solo lo usan las dos conexiones de Retia; ver la sección "Alcance" abajo.
//
// ─── Por qué existe ───────────────────────────────────────────────────────────
// Las dos conexiones de Retia (Tactical Investor y ComunicArte) apagaron la casilla nativa
// de SMS de Calendly y pusieron una pregunta de TEXTO LIBRE en su lugar (25 y 26 de agosto).
// Desde ese corte, el único número que existe es el que el lead teclea a mano al agendar. Y
// son las dos ÚNICAS conexiones con `hubspot:false`, o sea las únicas sin el rescate por CRM
// que tapa este hueco en 30X (ver resolvePhone en scheduler/calendly.js). Sin segunda fuente,
// un typo del lead sale derecho al link wa.me del closer y nadie se entera.
//
// Medido el 2026-09-18 sobre las dos conexiones, cruzando por email exacto contra el
// formulario del anuncio: de 175 citas comparables, 9 leads (5%) tenían en Calendly un número
// DISTINTO al que dejaron en el formulario. El caso que lo destapó (reportado por Michael,
// operaciones de Retia): Gustavo Laguna, call del 16-sep, `+57 300 3018595` en Calendly contra
// `+573006018595` en el formulario. Un dígito de diferencia.
//
// ⚠️ Validar la FORMA del número no sirve para esto, y por eso acá no se intenta:
// `+57 300 3018595` es un móvil colombiano impecable (prefijo 300, 10 dígitos). Ningún
// validador de forma puede saber que ese número no es de Gustavo. El error SOLO se ve contra
// una segunda fuente.
//
// ─── Lo que deliberadamente NO hace ───────────────────────────────────────────
// No decide cuál de los dos números es el bueno, y no clasifica "typo" contra "dos líneas
// reales". De las 9 discrepancias medidas, 5 eran de un dígito, 2 de dos dígitos y 2 eran
// números enteramente distintos (una lead vive en España y tiene línea allá y en Colombia).
// Todo umbral que separe esos grupos se equivoca en el medio, y la acción del closer es la
// MISMA en los tres casos: mirar los dos y escoger. Un clasificador agregaría umbral, tests y
// falsos negativos sin cambiar el resultado. Si difieren, van los dos.
//
// ─── Alcance ──────────────────────────────────────────────────────────────────
// Solo aplica a conexiones que DECLARAN su formulario (`leadForm` en accounts.js). 30X y
// EstadoX no lo declaran: su segunda fuente es HubSpot y ese camino no se toca.
//
// Todo este archivo es PURO salvo `fetchFormIndex`, que es el único que toca la red. Se puede
// testear en Windows sin compilar better-sqlite3.

import { phonesMatch } from '../common/utils.js';

// Tope de números alternos que se muestran en un push. Es una guarda de frontera, no una
// optimización: las filas salen de una hoja que el cliente edita a mano, y un email con diez
// teléfonos distintos convertiría el push en un muro ilegible. Medido sobre las dos hojas
// reales (2104 y 3884 filas): NINGÚN email tiene más de 2 teléfonos distintos, así que hoy
// este tope no recorta nada.
const MAX_ALTERNOS = 2;

// ─── Índice email → teléfonos (PURO) ──────────────────────────────────────────
// `rows` son las filas crudas del Sheet (arreglos de celdas, índice 0-based), tal como las
// devuelve src/sheets/client.js, encabezado incluido. Se exige un '@' en la celda del email:
// sin eso la fila de encabezado entra al índice (su "celda de email" es el texto de la
// pregunta, que no está vacío) y el conteo del log miente. Nunca haría daño —ese texto no
// matchea el email de ningún invitee— pero un índice que dice 2105 cuando tiene 2104 emails
// es un número que la próxima persona va a tener que ir a desmentir.
//
// La llave es el EMAIL en minúscula, nunca el nombre. No es un detalle: el primer cruce de
// esta investigación se hizo por nombre y le asignó a "Gustavo Laguna" el teléfono de un
// desconocido, porque en el formulario ese lead se llama "Gustavo Adolfo Laguna Leal". Un
// push a un número equivocado es PEOR que un push sin número.
export function buildFormIndex(rows, { emailCol = 1, phoneCol = 2 } = {}) {
  const index = new Map();
  for (const row of rows || []) {
    const email = String(row?.[emailCol] || '').trim().toLowerCase();
    const phone = String(row?.[phoneCol] || '').trim();
    if (!email || !phone || !email.includes('@')) continue;
    const previos = index.get(email);
    if (!previos) {
      index.set(email, [phone]);
      continue;
    }
    // Se guarda el teléfono TAL CUAL lo escribió el lead (con su + y sus espacios): es lo que
    // el closer va a leer y comparar contra la hoja. La deduplicación sí es por dígitos.
    if (!previos.some((p) => phonesMatch(p, phone))) previos.push(phone);
  }
  return index;
}

// Teléfonos que el formulario tiene para ese email. [] si no está (el lead agendó con otro
// correo, o nunca pasó por el formulario) — que es el caso de 18 de las 213 citas medidas.
export function formPhonesFor(index, email) {
  if (!index || !email) return [];
  return index.get(String(email).trim().toLowerCase()) || [];
}

// Los teléfonos del formulario que NO son el de Calendly. [] cuando coinciden (el 95%), que es
// donde el push tiene que salir exactamente igual que siempre.
//
// La comparación es `phonesMatch`, la misma que ya usa el roster de closers: compara por
// dígitos y por SUFIJO, así que "+57 300 1112222" y "3001112222" son el mismo número y no
// disparan una falsa alarma por el prefijo de país. El sufijo tiene una contrapartida conocida
// —un fragmento corto matchea un número largo que termine igual— y se acepta a propósito:
// falla hacia el comportamiento de hoy (no avisa), nunca hacia un link de más.
export function altPhonesFor(calendlyPhone, formPhones) {
  if (!calendlyPhone) return [];
  return (formPhones || [])
    .filter((p) => p && !phonesMatch(calendlyPhone, p))
    .slice(0, MAX_ALTERNOS);
}

// ─── Lectura del Sheet (IMPURO, el único de este archivo) ─────────────────────
// `fetchSheetValues` entra por parámetro para poder testear sin red. Devuelve null —no
// lanza— ante cualquier problema: la conexión sin `leadForm`, sin credenciales, o un fallo
// de la API. Null significa "no hay segunda fuente" y el poll se comporta igual que antes de
// este cambio. Un push NUNCA se bloquea porque la hoja no respondió.
export async function fetchFormIndex(account, { fetchSheetValues } = {}) {
  const form = account?.leadForm;
  if (!form?.id || !form?.tab || !fetchSheetValues) return null;
  try {
    const rows = await fetchSheetValues({ id: form.id, tab: form.tab });
    if (!rows?.length) return null;
    const index = buildFormIndex(rows, form);
    console.log(
      `[Calendly] formulario de ${account.key}: ${index.size} emails con teléfono (2da fuente del número del lead)`
    );
    return index;
  } catch (e) {
    console.warn(
      `[Calendly] ⚠️ no pude leer el formulario de ${account.key} (${e.message}) — los pushes salen sin el cruce de teléfono`
    );
    return null;
  }
}
