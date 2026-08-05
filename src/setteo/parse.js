// src/setteo/parse.js
// PURO (sin red, sin DB, sin env obligatorio → testeable en Windows). Extrae de lo que el
// closer escribió por WhatsApp: la fecha, los leads que tocó y el resultado de cada uno.
//
// Es DELIBERADAMENTE conservador. Cubre las formas estructuradas y frecuentes ("toqué a Juan
// Pérez, no contestó", "María Gómez agendó", "/setteo Ana Ruiz | venta") y devuelve `none`
// ante cualquier cosa dudosa. Lo que no entiende acá lo intenta setteo-ai.js, igual que
// reschedule-parse.js → reschedule-ai.js. La razón de no forzar el regex: un falso positivo
// escribe un lead inventado en la tabla del closer, y ese error es más caro que repreguntar.
//
// Contrato de salida:
//   { kind: 'setteos', fecha, items: [{ leadName, leadNorm, contesto, agendo, vendio }] }
//   { kind: 'agregado', fecha, conteo, agendaron }  → dijo cuántos pero no quiénes
//   { kind: 'none' }

import { normalizeLeadName } from '../common/utils.js';

const TZ = () => process.env.TZ || 'America/Bogota';

// 'YYYY-MM-DD' en la zona del negocio. NUNCA toISOString(): en Bogotá (UTC-5) eso devuelve
// el día siguiente a partir de las 19:00, así que todo lo que el closer reporta de noche
// —que es justo cuando cierra el día— quedaría con fecha de mañana.
export function localDateISO(base = new Date(), tz = TZ()) {
  return new Date(base).toLocaleDateString('en-CA', { timeZone: tz });
}

// Suma días a una fecha 'YYYY-MM-DD' sin pasar por Date local (evita el corrimiento por DST
// y por el TZ del proceso: se opera sobre el mediodía UTC del día en cuestión).
export function shiftDateISO(iso, days) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const t = Date.UTC(y, m - 1, d, 12) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

const strip = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

// ─── Fecha ────────────────────────────────────────────────────────────────────
// Solo lo inequívoco. "el lunes" NO se resuelve acá (¿el que pasó o el que viene?): cae a
// hoy y, si el closer quería otra cosa, la IA o la repregunta lo arreglan.
export function parseFecha(text, { now = new Date(), tz = TZ() } = {}) {
  const hoy = localDateISO(now, tz);
  const t = strip(text);

  if (/\bantier\b|\banteayer\b/.test(t)) return shiftDateISO(hoy, -2);
  if (/\bayer\b/.test(t)) return shiftDateISO(hoy, -1);

  // DD/MM o DD-MM (año opcional). Se acepta solo si NO es futuro: un setteo se reporta
  // después de hacerlo, así que una fecha futura es un error de tipeo, no una intención.
  const m = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/.exec(t);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    let y = m[3] ? Number(m[3]) : Number(hoy.slice(0, 4));
    if (y < 100) y += 2000;
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
      const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (iso <= hoy) return iso;
    }
  }
  return hoy;
}

// ─── Resultado ────────────────────────────────────────────────────────────────
// Los negativos se evalúan ANTES que los positivos: "no contestó" contiene "contestó", así
// que el orden es lo único que separa un lead que respondió de uno que no.
// "ninguno/nadie" van acá y no como stopword suelta: "ninguno contestó" contiene "contestó",
// así que sin esta rama el lead quedaría marcado como que SÍ respondió — exactamente al revés.
const NEG_CONTESTO = /\b(?:no (?:me )?(?:contest|respond|contesta|responde)\w*|sin respuesta|ni (?:bola|se asomo)|no (?:dio|da) senales|nunca (?:contest|respond)\w*|dejo en visto|ningun[oa]|nadie)\b/;
const POS_CONTESTO = /\b(?:contest\w*|respond\w*|me escribio|hable con|hablamos|atendio|si contesto|converse|charlamos|me contesto)\b/;
const AGENDO = /\b(?:agend\w*|cit[oa]\b|citada|reservo|quedo (?:para|el|la)|programada|booking|separo (?:el )?espacio|quedamos (?:para|el))\b/;
const VENDIO = /\b(?:vent[ao]\b|vendi\w*|cerr[oe]\w*|compro|pago|pagada|cerrada|se cerro|firmo)\b/;
// "en seguimiento" implica que hubo conversación, pero NO agenda ni venta.
const SEGUIMIENTO = /\b(?:seguimiento|lo (?:estoy )?trabajando|pensarlo|lo piensa|interesad\w+|tibio|nurture|va a pensar|me dijo que despues)\b/;

// Devuelve { contesto, agendo, vendio, matched } de un fragmento de texto.
// `matched` distingue "dijo explícitamente que no contestó" de "no dijo nada del resultado".
export function parseResultado(fragment) {
  const t = strip(fragment);
  const out = { contesto: 0, agendo: 0, vendio: 0, matched: false };

  if (VENDIO.test(t)) {
    out.vendio = 1;
    out.contesto = 1;
    out.matched = true;
  }
  if (AGENDO.test(t)) {
    out.agendo = 1;
    out.contesto = 1;
    out.matched = true;
  }
  // El negativo solo manda si no hubo una señal más fuerte: "no contestó al principio pero
  // agendó" tiene que quedar como agendado.
  if (!out.agendo && !out.vendio && NEG_CONTESTO.test(t)) {
    out.contesto = 0;
    out.matched = true;
    return out;
  }
  if (POS_CONTESTO.test(t) || SEGUIMIENTO.test(t)) {
    out.contesto = 1;
    out.matched = true;
  }
  return out;
}

// ─── Nombres ──────────────────────────────────────────────────────────────────
// Palabras que nunca son parte de un nombre: si aparecen, se corta ahí. Sin esto,
// "toqué a Juan y no contestó" produciría el lead "Juan Y No".
const STOP = new Set(
  ('y e o pero que porque como cuando donde si no ni de del al a con por para sin sobre me le lo la ' +
   'los las un una unos unas el en es esta este hoy ayer antier manana tarde noche ' +
   'contesto contesta contestaron respondio responde respondieron agendo agenda agendaron cita citas ' +
   'venta ventas vendio vendi cerro cerre compro pago seguimiento interesado interesada nada ' +
   'todavia aun ya tambien igual mas menos muy solo casi quedo quedamos hable hablamos leads lead ' +
   'ninguno ninguna nadie todos todas ambos ninguna mismo tampoco ' +
   // Verbos de CORRECCIÓN. Sin esto, "Elimina contestk" hacía que la regla 3 leyera "Elimina"
   // como nombre propio (arranca en mayúscula) y "contestk" como resultado → el closer pedía
   // BORRAR y se le CREABA un lead llamado "Elimina". Pasó en el smoke del 2026-08-04.
   'elimina eliminar elimine borra borrar borre descarta descartar descarte quita quitar quite ' +
   'anula anular corrige corregir corrige cambia cambiar olvida olvidar ignora ignorar')
    .split(/\s+/)
);

// Raíces de los verbos de RESULTADO. Una palabra que empieza así no es un nombre de lead, por
// más que el closer la escriba con mayúscula o la tipee mal: "contestk", "agendoo",
// "respondiio". STOP no alcanza porque es por palabra EXACTA y los typos son infinitos.
const RAIZ_RESULTADO = /^(contest|respond|agend|vend|cerr|compr|pag|interes)/;

// Corta una tirada de texto en un nombre plausible: hasta 4 palabras, sin stopwords,
// sin dígitos. Devuelve '' si no queda nada usable.
function takeName(raw) {
  const words = [];
  for (const w of String(raw || '').trim().split(/\s+/)) {
    const clean = w.replace(/[^\p{L}\p{N}'-]/gu, '');
    if (!clean) break;
    if (/\d/.test(clean)) break;
    if (STOP.has(strip(clean))) break;
    // Un resultado mal escrito no es un lead. En el smoke, "toqué a Andrea Gomez, contestk"
    // guardó DOS filas: Andrea y otra llamada "contestk".
    if (RAIZ_RESULTADO.test(strip(clean))) break;
    words.push(clean);
    if (words.length === 4) break;
  }
  return words.join(' ');
}

// Parte "Juan, María y Pedro, ninguno contestó" en { names: [Juan, María, Pedro],
// tail: 'ninguno contestó' }. Corta en el primer trozo que no sea un nombre: de ahí en
// adelante es el resultado, no más gente.
function splitNamesAndTail(chunk) {
  const pieces = String(chunk || '').split(/\s*(?:,|;|\/|\+|\by\b|\be\b)\s*/i);
  const names = [];
  let i = 0;
  for (; i < pieces.length; i++) {
    const n = takeName(pieces[i]);
    if (!n) break;
    names.push(n);
  }
  return { names, tail: pieces.slice(i).join(' ').trim() };
}

const TRIGGER = /(?:toqu[eé]|habl[eé]|escrib[ií]|contact[eé]|llam[eé]|mand[eé] mensaje|le escrib[ií]|segu[ií])\s+(?:a|con|al)\s+([^.;\n]+)/giu;

// Dentro de UN mismo mensaje, "María" y "María Gómez" son la misma persona: el closer nombra
// al lead completo la primera vez y luego lo abrevia ("toqué a Juan Pérez y María Gómez,
// María agendó"). Sin esta pasada quedan DOS filas para la misma persona, el conteo se infla
// y la mitad del embudo cae en el nombre incompleto.
//
// Se funde solo cuando NO hay ambigüedad: si el nombre corto encaja en dos largos distintos
// ("Juan" con "Juan Pérez" y "Juan Gómez" en el mismo mensaje), se deja como está — adivinar
// ahí le atribuiría la gestión al lead equivocado.
export function consolidar(items) {
  const porPalabras = items.map((it) => ({ it, w: it.leadNorm.split(' ') }));
  const absorbido = new Set();

  for (const corto of porPalabras) {
    const candidatos = porPalabras.filter(
      (largo) => largo !== corto && largo.w.length > corto.w.length && corto.w.every((x) => largo.w.includes(x))
    );
    if (candidatos.length !== 1) continue; // 0 = no aplica · 2+ = ambiguo, no se toca
    const largo = candidatos[0];
    largo.it.contesto = Math.max(largo.it.contesto, corto.it.contesto);
    largo.it.agendo = Math.max(largo.it.agendo, corto.it.agendo);
    largo.it.vendio = Math.max(largo.it.vendio, corto.it.vendio);
    absorbido.add(corto.it);
  }

  return items.filter((it) => !absorbido.has(it));
}

// ─── Guard de intención: esto NO es un reporte, es una corrección ─────────────
// El closer que dice "descartá el de Juan" está pidiendo BORRAR, y la captura determinista
// —que solo sabe crear— no tiene nada que hacer con ese mensaje. Sin este guard, en el smoke
// del 2026-08-04 pasó tres veces seguidas: dijo *borra* y Juanito *creó*, incluido un lead
// llamado "Elimina".
//
// Es DELIBERADAMENTE liberal, y se puede permitir serlo: el mensaje que este guard deja pasar
// cae en el contexto agéntico, que tiene las TRES tools (registrar, consultar y corregir). O
// sea que un falso positivo no pierde nada —el setteo se registra igual, por el otro camino—
// mientras que un falso negativo le crea al closer un lead fantasma que después tiene que
// pedir que le borren. Los costos no son simétricos, y el guard se inclina hacia el barato.
const CORRECCION =
  /\b(descarta\w*|elimina\w*|borra\w*|borre\w*|quita\w*|quite\w*|anula\w*|corrig\w*|olvida\w*|ignora\w*|no era|no fue|me equivoqu\w*|estaba mal|est[aá] mal|mentira\w*)\b/i;

export function esCorreccion(text) {
  return CORRECCION.test(strip(String(text || '')));
}

// ─── Entrada principal ────────────────────────────────────────────────────────
export function parseSetteoReply(text, { now = new Date(), tz = TZ() } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { kind: 'none' };

  const fecha = parseFecha(raw, { now, tz });
  const items = new Map(); // leadNorm → item (dedup dentro del MISMO mensaje)

  const add = (leadName, resultado) => {
    const leadNorm = normalizeLeadName(leadName);
    if (!leadNorm || leadNorm.length < 2) return;
    const prev = items.get(leadNorm) || { leadName, leadNorm, contesto: 0, agendo: 0, vendio: 0 };
    prev.contesto = Math.max(prev.contesto, resultado.contesto);
    prev.agendo = Math.max(prev.agendo, resultado.agendo);
    prev.vendio = Math.max(prev.vendio, resultado.vendio);
    items.set(leadNorm, prev);
  };

  // 1) Forma explícita del comando: "Ana Ruiz | agendó" (una por línea).
  for (const line of raw.split('\n')) {
    const m = /^\s*([^|]{2,60}?)\s*\|\s*(.+)$/.exec(line);
    if (!m) continue;
    const nombre = takeName(m[1]);
    if (nombre) add(nombre, parseResultado(m[2]));
  }

  // 2) Verbo gatillo + lista de nombres: "toqué a Juan, María y Pedro, ninguno contestó".
  //    El resultado de la cola aplica a TODOS los de la lista, pero SOLO si en esa cola no
  //    hay otro nombre propio. "toqué a Juan, María agendó" no puede marcar a Juan como
  //    agendado: ahí la cola habla de María, y de eso se encarga la regla 3.
  for (const m of raw.matchAll(TRIGGER)) {
    const { names, tail } = splitNamesAndTail(m[1]);
    if (!names.length) continue;
    const colaTieneOtroNombre = /\b[A-ZÁÉÍÓÚÑ][\p{L}'-]{2,}/u.test(tail);
    const res = colaTieneOtroNombre
      ? { contesto: 0, agendo: 0, vendio: 0, matched: false }
      : parseResultado(tail);
    for (const n of names) add(n, res);
  }

  // 3) "<Nombre> agendó" / "<Nombre> no contestó" — nombre seguido del resultado.
  //    Exige que el nombre arranque con MAYÚSCULA: en minúsculas la ambigüedad con el resto
  //    de la frase es demasiado alta y prefiero mandarlo a la IA que inventar un lead.
  const NAME_FIRST = /(?:^|[.;,\n]|\by\b\s+)\s*([A-ZÁÉÍÓÚÑ][\p{L}'-]+(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}'-]+){0,3})\s+((?:no\s+)?(?:contest|respond|agend|vend|cerr|compr|pag)\w*[^.;\n]{0,60})/gu;
  for (const m of raw.matchAll(NAME_FIRST)) {
    const nombre = takeName(m[1]);
    if (!nombre) continue;
    const res = parseResultado(m[2]);
    if (res.matched) add(nombre, res);
  }

  if (items.size) return { kind: 'setteos', fecha, items: consolidar([...items.values()]) };

  // 4) Sin nombres, pero con cantidades: "20 leads hoy, 3 agendaron". No se puede guardar
  //    (la tabla es una fila por lead y el cruce con HubSpot necesita el nombre), así que se
  //    devuelve como agregado para que Juanito pida los nombres. Inventar filas para cuadrar
  //    el número sería escribir datos falsos.
  const nLeads = /\b(\d{1,3})\s*(?:leads?|contactos?|personas?|setteos?|toqu[eé])/i.exec(raw);
  if (nLeads) {
    const nAgenda = /\b(\d{1,3})\s*(?:agend\w*|cit\w*)/i.exec(raw);
    return {
      kind: 'agregado',
      fecha,
      conteo: Number(nLeads[1]),
      agendaron: nAgenda ? Number(nAgenda[1]) : null,
    };
  }

  return { kind: 'none' };
}
