// src/calendly/closers.js
// Roster de closers keyeado por PERSONA. Cada persona tiene una o más IDENTIDADES, una por
// Conexión de Calendly (ver ADR 0001): su email de host (event_memberships[0].user_email de
// sus citas ES el closer), su teléfono canónico y, si aplica, su LID de trabajo. De este
// roster se DERIVAN, con estructura idéntica a la de antes:
//   · CLOSERS      — mapa email → { name, phone, account? }  (una entrada por IDENTIDAD)
//   · CLOSER_LIDS  — mapa lid → email                        (de las identidades con workLid)
// El resto del código consume esos dos mapas; la persona es solo la unidad de autoría, para que
// sumar/mover un closer sea editar UNA entrada aunque cierre para dos empresas.
//
// EQUIPO — lista dictada por el jefe el 2026-07-14 y validada contra la cuenta real de Calendly.
// Estos son TODO el equipo: quien no esté acá, no se gestiona. (Los pools a los que pertenece
// hoy cada uno son informativos; el PROGRAMA de cada cita se deriva de su event_type, no se
// configura acá, así que un closer queda cubierto en TODOS sus programas sin tocar nada más.)
//   Pablo Lozano        AI Second Brain · AI For Developers
//   Sebastian Rodriguez AI Second Brain (30X) · De Cero a Tactical Investor (Retia)
//   Sebastian Marin     LinkedIn Sales  · Instagram & TikTok
//   Lucas Mendoza       LinkedIn Sales  · Operaciones Escalables
//   Pablo Suarez        AI For Developers
//   Daniela Camacho     EstadoX (IA para Abogados) · Instagram & TikTok · Operaciones Escalables
//   Sebastian Salazar   EstadoX (IA para Abogados) · De Cero a Tactical Investor (Retia)
//   Andrea Machado      Retia — De Cero a Tactical Investor
//
// La CONEXIÓN de Calendly se configura en cada identidad con `connection` (ver accounts.js).
// La identidad cuya connection es la default ('30x') NO emite el campo `account` en el CLOSERS
// derivado (idéntico al roster histórico); las demás sí.
//
// ⚠️ INVARIANTE (revisada 2026-07-22): un teléfono = una PERSONA, nunca dos personas distintas.
// Una misma persona SÍ puede tener dos identidades con el MISMO teléfono en Conexiones distintas
// (Sebastian Salazar: 30x + retia desde una sola línea de WhatsApp). NO necesita la migración a
// clave compuesta que antes se temía, porque:
//   · La CUENTA/dry-run/HubSpot se resuelven por EMAIL (accountOfCloser), distinto por identidad
//     → cada programa cae a lo suyo sin ambigüedad.
//   · El OPT-IN es lo único keyed por teléfono (`calendly_optins.phone` PK, contact_jid). UNA
//     sola fila sirve a las dos identidades y es CORRECTO: es el mismo WhatsApp. `registerOptin`
//     hace upsert por teléfono → una fila, nunca choca la PK.
//   · `pickSupersededPushes` matchea por (teléfono, MISMO lead): un lead postula a un solo
//     programa, así que no se pisan pushes entre programas.
//   · El PAUSE por-closer es por IDENTIDAD (email, en la tabla `settings`), no por teléfono → se
//     apaga un programa sin el otro. Ver setCloserPaused/isCloserPaused y `/calendly off <closer>
//     <cuenta>`.
// Lo que SÍ rompería la DB es dos PERSONAS distintas con el mismo teléfono (se pisarían el
// opt-in). El test "un teléfono = una persona" en calendly.closers.test.js lo bloquea.

import { phonesMatch } from '../common/utils.js';
import { DEFAULT_ACCOUNT, accountOf } from './accounts.js';

const PEOPLE = {
  daniela_camacho: {
    name: 'Daniela Camacho',
    // Teléfono actualizado 2026-07-28 (jefe): +573103062287 → +573018094666.
    // ⚠️ Rotar un número tiene DOS pasos: este roster es solo la LLAVE del opt-in; el destino
    // real de los pushes es `calendly_optins.contact_jid`. Ver el patrón de Pablo Suarez (§18.AJ)
    // y el runbook de rotación en docs/JUANITO-HANDOFF.md.
    identities: [{ connection: '30x', email: 'daniela.camacho@30x.com', phone: '+573018094666' }],
  },
  // Sebastian Rodriguez: UNA persona, DOS identidades. Cierra AI Second Brain en 30X y "De Cero a
  // Tactical Investor" en Retia, con host/teléfono distinto en cada Calendly. Antes eran dos
  // entradas con nombre repetido; ahora es una sola (ADR 0001). resolveCloserByPushName ve el
  // nombre repetido en el CLOSERS derivado (dos teléfonos) → null (ambiguo = SEGURO); NO lo
  // bloquea: el opt-in resuelve por TELÉFONO/LID antes que por pushName, así que cada identidad
  // entra por lo suyo (30x por su LID de trabajo; retia por su celular +57 300 8037326).
  sebastian_rodriguez: {
    name: 'Sebastian Rodriguez',
    identities: [
      // workLid: su pushName de trabajo NO trae "Rodriguez"; el LID PINNEA la entrega al hilo
      // de trabajo aunque escriba desde otro dispositivo. NUNCA un LID personal (recrearía el
      // bug de pushes al número equivocado).
      { connection: '30x', email: 'sebastian@30x.com', phone: '+573102212005', workLid: '158025419608301' },
      // Gmail = su host en el Calendly de retia (9 citas verificadas). Entró 2026-07-21
      // (reemplazó a Alejo Carvajal → IGNORED_CLOSERS).
      // workLid capturado 2026-07-21: escribió "Hola bro" a Juanito desde su WhatsApp de retia y
      // WhatsApp lo presentó como 20671711162446@lid (contacts lo liga a +573008037326). Sin este
      // mapeo su opt-in caía a null: el pushName "Sebastian Rodriguez" es ambiguo (2 identidades),
      // así que resolveCloserByLid es la única vía. PINNEA la entrega a su device de retia.
      { connection: 'retia', email: 'sebasrr321@gmail.com', phone: '+573008037326', workLid: '20671711162446' },
    ],
  },
  // UNA persona, DOS identidades con el MISMO teléfono (excepción al patrón de Sebastian
  // Rodriguez, que usa dos números). Cierra IA para Abogados en 30x y "De Cero a Tactical
  // Investor" en Retia desde la misma línea de WhatsApp. Comparten opt-in (una fila por teléfono)
  // — correcto: es el mismo hilo. La cuenta/dry-run se resuelve por EMAIL, distinto en cada
  // identidad, así que cada programa cae a lo suyo. El pause es por-identidad (por email, en
  // `settings`), no por teléfono → se apaga un programa sin el otro (`/calendly off Sebastian
  // Salazar retia`). Reemplazó a Dana en Retia (2026-07-22). El nombre queda corto ("Sebastian
  // Salazar", no "Juan Sebastian Salazar") para no romper el match por pushName de su hilo 30x.
  //
  // ⚠️ CORRECCIÓN 2026-07-29 — su identidad de retia es el BUZÓN-ROL `equipo@ttrading.co`, NO un
  // correo personal. El 22-jul se asumió que tendría cuenta propia (sebastiansalazar1410@gmail.com)
  // y en el mismo movimiento se retiró el buzón a IGNORED_CLOSERS. Esa cuenta NUNCA se creó: medido
  // contra la API de Retia el 29-jul, la org tiene 4 miembros (equipo@, jvieira@, registro@,
  // sebasrr321@) y no hay invitación pendiente para ese gmail. Resultado: CERO filas de push para
  // el correo fantasma y 10 citas reales hosteadas por equipo@ cayendo en el `continue` SILENCIOSO
  // de isIgnoredCloser — una semana sin pushes y sin una sola alerta. En Retia los cupos se
  // atienden por BUZÓN-ROL (mismo patrón que registro@ → Andrea Machado), no por cuenta personal.
  // Al rotar la persona del buzón hay que cambiar el TELÉFONO acá (este roster es solo la LLAVE del
  // opt-in; el destino real es `calendly_optins.contact_jid` — runbook en docs/JUANITO-HANDOFF.md).
  sebastian_salazar: {
    name: 'Sebastian Salazar',
    identities: [
      { connection: '30x', email: 'sebastian.salazar@30x.com', phone: '+573054312905' },
      { connection: 'retia', email: 'equipo@ttrading.co', phone: '+573054312905' },
    ],
  },
  pablo_lozano: {
    name: 'Pablo Lozano',
    identities: [{ connection: '30x', email: 'pablo.lozano@30x.com', phone: '+573046131437' }],
  },
  sebastian_marin: {
    name: 'Sebastian Marin',
    identities: [{ connection: '30x', email: 'sebastian.marin@30x.com', phone: '+573212100048' }],
  },
  lucas_mendoza: {
    name: 'Lucas Mendoza',
    identities: [{ connection: '30x', email: 'lucas.mendoza@30x.com', phone: '+573014477044' }],
  },
  // OJO: su email NO lleva punto (pablosuarez@), a diferencia de pablo.lozano@ — personas
  // distintas, ambas activas. Entró 2026-07-14.
  pablo_suarez: {
    name: 'Pablo Suarez',
    // Teléfono actualizado 2026-07-21 (jefe): +573152573103 → +573189248507.
    // `hubspotEmail`: en HubSpot su owner NO es pablosuarez@ sino pablosuarez+hubspot@ (medido
    // 2026-07-27, owner 95239179). Sin este alias, `meetingsToCalls` descartaba sus 28 meetings
    // al mes — la agenda del día no veía UNA sola call de AI for Developers y el diagnóstico
    // parecía "developers no existe en HubSpot". Ver §18.AN.
    identities: [
      { connection: '30x', email: 'pablosuarez@30x.com', phone: '+573189248507', hubspotEmail: 'pablosuarez+hubspot@30x.com' },
    ],
  },
  // ─── Retia (agencia #2) — programa "De Cero a Tactical Investor" ───────────
  // Vieira VENDE el programa (la CARA del pitch), NO es closer → está en IGNORED_CLOSERS.
  // registro@ es un correo DE LA EMPRESA (rol, no personal): si sacan a la closer, el correo pasa
  // al siguiente → al rotar, actualizar el teléfono acá (patrón "Equipo EstadoX").
  // "Andrea Machado" choca de nombre con andrea.machado@30x.com (DEPARTIDA, en IGNORED_CLOSERS):
  // persona DISTINTA, no está en el roster → no confunde a resolveCloserByPushName.
  // Dana salió (2026-07-22): la reemplazó Sebastian Salazar, que SÍ heredó el buzón-rol
  // equipo@ttrading.co (ver PEOPLE.sebastian_salazar y la corrección del 2026-07-29). Retia opera
  // con DOS buzones-rol —registro@ y equipo@—, ninguno con cuenta personal detrás.
  andrea_machado: {
    name: 'Andrea Machado',
    identities: [{ connection: 'retia', email: 'registro@ttrading.co', phone: '+573132484664' }],
  },
};

// ─── Derivación: mapa email → { name, phone, account? } (una entrada por IDENTIDAD) ──────────
// account se emite SOLO cuando la connection no es la default → el CLOSERS resultante es idéntico
// al roster histórico (las identidades 30x sin campo `account`, las de retia con account:'retia').
export const CLOSERS = Object.fromEntries(
  Object.values(PEOPLE).flatMap((person) =>
    person.identities.map((id) => {
      const entry = { name: person.name, phone: id.phone };
      if (id.connection !== DEFAULT_ACCOUNT) entry.account = id.connection;
      return [id.email.toLowerCase(), entry];
    })
  )
);

// ─── Derivación: owner de HubSpot → email CANÓNICO del closer ────────────────────────────────
// El email con el que una persona es owner en HubSpot no siempre es el mismo con el que hostea
// en Calendly (Pablo Suarez: pablosuarez+hubspot@ vs pablosuarez@). Este mapa hace de puente en
// las DOS direcciones que importan:
//   · pertenencia — ¿este owner es uno de nuestros closers? (antes: un Set de emails de Calendly,
//     que dejaba fuera a quien tuviera alias)
//   · canonicalización — la fila que sale de HubSpot debe llevar el email de CALENDLY, no el de
//     HubSpot. Si no, la misma call no deduplica contra su gemela de Calendly (`dedupKey` va por
//     email) y el jefe la ve DOS VECES; y `resolveCloser` no encuentra el nombre.
// La identidad siempre se mapea a sí misma, así que sin `hubspotEmail` el comportamiento es el
// de antes. Clave y valor en minúsculas.
export const HUBSPOT_OWNER_TO_CLOSER = Object.fromEntries(
  Object.values(PEOPLE).flatMap((person) =>
    person.identities.flatMap((id) => {
      const canonical = id.email.toLowerCase();
      const pairs = [[canonical, canonical]];
      if (id.hubspotEmail) pairs.push([id.hubspotEmail.toLowerCase(), canonical]);
      return pairs;
    })
  )
);

// LIDs de TRABAJO conocidos (derivados de las identidades con `workLid`): para closers cuyo @lid
// no mapea a su teléfono canónico y cuyo pushName no permite el match. Mapear el LID de trabajo
// hace que el bot lo reconozca y que su contact_jid se AUTOCORRIJA al hilo correcto en vez de
// driftear al número equivocado. Clave = solo dígitos del LID (sin @lid); valor = email del closer.
export const CLOSER_LIDS = Object.fromEntries(
  Object.values(PEOPLE).flatMap((person) =>
    person.identities.filter((id) => id.workLid).map((id) => [id.workLid, id.email.toLowerCase()])
  )
);

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
  // Retia (2026-07-21):
  'jvieira@ttrading.co',      // Juan Pablo Vieira VENDE el programa (cara), no es closer. Tomó citas
                              // en el pasado (12 en la ventana) pero YA NO → skip silencioso.
  'alejocarpa1108@gmail.com', // salió de Tactical Investor 2026-07-21; lo reemplazó Sebastian Rodriguez.
  // NO agregar 'equipo@ttrading.co': es el buzón-rol que hoy atiende Sebastian Salazar y vive en
  // CLOSERS (ver PEOPLE.sebastian_salazar). Estuvo acá del 22 al 29 de julio por asumir que Salazar
  // tendría cuenta propia, y ese skip silencioso le costó una semana de pushes.
  // Owner de HubSpot, NO de Calendly. Decisión del jefe 2026-07-27: se ignora para que el poll de
  // meetings no dispare alertas de "closer sin mapear" ni le meta sesiones a la agenda del jefe.
  //
  // ⚠️ CORRECCIÓN 2026-07-29 — la razón anotada acá ("383 meetings 'Sesión Programa LinkedIn
  // Sales 30X' en 30 días ⇒ son sesiones grupales") NO se reproduce. Medido directo por ownerId
  // (90154139), 30 días, paginado hasta agotar: 246 meetings, de los cuales "Sesión Programa
  // LinkedIn Sales 30X" son 18, no 383. El grueso son ~200 "AI Second Brain Admisiones — <lead>",
  // UNO por lead y con UN solo contacto asociado (75 de 100 en la muestra) → son calls 1-a-1,
  // no sesiones. Las grupales (Office Hour, Sesión N, Networking Dinner) son ~32.
  // O sea: el volumen 1-a-1 existe. Mantener o no la exclusión es decisión del jefe, no un dato
  // técnico; mientras siga acá no recibe pushes —y de todos modos no podría, porque no está en el
  // roster (sin teléfono) ni tiene opt-in ganado.
  'danieltovar@30x.com',
]);

export function isIgnoredCloser(email) {
  if (!email) return false;
  return IGNORED_CLOSERS.has(String(email).toLowerCase().trim());
}

// Devuelve { name, phone } | null
export function resolveCloser(email) {
  if (!email) return null;
  return CLOSERS[String(email).toLowerCase().trim()] || null;
}

// Key de la cuenta de Calendly a la que pertenece un closer. Es la REGLA ÚNICA con la que
// se decide todo lo que sale hacia un closer (dry-run, Push 4, HubSpot): el closer siempre
// se conoce — en el loop de entrega por `closer_email` de la fila, en los digests porque
// agrupan por closer — mientras que el programa puede venir NULL en filas viejas.
// Un email desconocido cae a la cuenta default, que es el comportamiento histórico.
export function accountOfCloser(email) {
  const c = CLOSERS[String(email || '').toLowerCase().trim()];
  return c?.account || DEFAULT_ACCOUNT;
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
    // Un nombre de UNA sola palabra ("Dana") no identifica a nadie: matchearía a cualquier
    // desconocido cuyo nombre de WhatsApp la contenga ("Dana Beauty Salon", "Juan Andrea").
    // Y el match acá NO es inocuo: handleCloserOptin le pone al opt-in del closer el
    // contact_jid de QUIEN ESCRIBIÓ → todos sus pushes (con nombres y teléfonos de leads)
    // se irían a esa persona. Mismo bug que 491f604, pero disparable por cualquiera.
    // Un nombre de una palabra es ambiguo por definición → mismo trato que la ambigüedad.
    if (closerWords.length < 2) continue;
    // Exigir que TODAS las palabras del closer estén en el pushName (evita falsos parciales)
    if (closerWords.every(w => words.includes(w))) {
      if (!seen.has(c.phone)) seen.set(c.phone, { email, name: c.name, phone: c.phone });
    }
  }
  return seen.size === 1 ? [...seen.values()][0] : null;
}

// TODAS las identidades cuyo nombre de closer matchea `name` (nombre completo). A diferencia de
// resolveCloserByPushName —que colapsa a null ante ambigüedad para NO auto-registrar al closer
// equivocado—, acá devolvemos la LISTA completa a propósito: la usa `/calendly on|off <closer>`
// para desambiguar por CONEXIÓN cuando una persona tiene 1+ identidades (ej: Sebastian Rodriguez
// en 30x y en retia). Cada elemento: { email, name, phone, account, accountLabel }, con
// account = key de la Conexión (DEFAULT_ACCOUNT para la identidad default). Dedup por teléfono
// (una identidad = un teléfono, invariante del roster). Vacío si no matchea nadie.
export function resolveIdentitiesByName(name) {
  if (!name) return [];
  const words = nameWords(name);
  if (!words.length) return [];
  const out = [];
  // Dedup por (teléfono, cuenta): una persona puede tener DOS identidades con el MISMO teléfono en
  // cuentas distintas (Sebastian Salazar: 30x + retia) → hay que listar AMBAS para que el dev
  // desambigüe por cuenta. Solo colapsa un duplicado real (mismo teléfono Y misma cuenta, que no
  // debería existir en el roster).
  const seen = new Set();
  for (const [email, c] of Object.entries(CLOSERS)) {
    const closerWords = nameWords(c.name);
    if (closerWords.length < 2) continue; // un nombre de una palabra no identifica a nadie
    if (!closerWords.every((w) => words.includes(w))) continue;
    const account = c.account || DEFAULT_ACCOUNT;
    const key = `${c.phone}|${account}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ email, name: c.name, phone: c.phone, account, accountLabel: accountOf(account)?.label || account });
  }
  return out;
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
