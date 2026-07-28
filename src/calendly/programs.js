// src/calendly/programs.js
// Registro de PROGRAMS — objeto de PRIMERA CLASE. FUENTE ÚNICA de todo lo de un programa
// junto: su label, su empresa (marca de cara al lead), qué Conexión de Calendly lo hostea,
// su event_type, su pitch y sus materiales. De acá se DERIVAN los mapas que el resto del
// código ya consumía (eventTypeToProgram, los eventTypes por conexión, PROGRAM_LABELS,
// PROGRAM_PITCH, MATERIAL_LINKS) → cambiar un programa es editar UNA entrada, no cinco.
//
// Por qué existe (handoff §18.AJ / ADR 0001): antes el mapeo ET→programa vivía en accounts.js
// y el copy (pitch/materiales/label) en index.js. Sumar un programa tocaba 5 lugares en 2
// archivos sin nada que validara consistencia. Unificarlo acá es reshaping de DATOS, no de
// lógica: las derivaciones de abajo mantienen firma y salida idénticas a los mapas viejos.
//
// Cómo se agrega un programa: UNA entrada en PROGRAMS con su connection, eventType, pitch y
// materiales. Si su Conexión es nueva (otro Calendly), agregarla también en accounts.js.
// Sin copy (pitch/materiales) el push degrada a "mándalo manual" — nunca al pitch de otro
// programa (red de seguridad en buildPrecallText).

// ─── event_types por programa ─────────────────────────────────────────────────
// Los event_types tipo POOL NO se pueden enumerar por la API (el query org-wide de
// /event_types solo devuelve los kind=solo). Se resuelven mirando el `event_type` de las
// reservas reales en /scheduled_events — así se resolvieron Instagram (2026-07-16) y Tactical
// Investor (2026-07-21). Mismo método si aparece otro. Atajo: scripts/calendly-account-derive.js.
const SECOND_BRAIN_ET = 'https://api.calendly.com/event_types/56efc028-ee2f-46e8-852c-e50d45b15b83';
const ABOGADOS_ET = 'https://api.calendly.com/event_types/f8d123ac-364b-47f9-a446-1316fdf37b08';
const LINKEDIN_ET = 'https://api.calendly.com/event_types/96ddf036-9174-459c-be73-b248ad95be13';
const DEVELOPERS_ET = 'https://api.calendly.com/event_types/dff3e48a-4859-417a-98fb-822048aef5d9';
const OPERACIONES_ET = 'https://api.calendly.com/event_types/8462e92a-8210-4bb2-8e2b-583aa3c3d877';
const INSTAGRAM_ET = 'https://api.calendly.com/event_types/d33075cb-d349-43ef-be43-6f80f9c5da03';
// Retia — único ET de venta de ese Calendly (los otros tipos: Revisión de Portafolio, Asesoría,
// etc., NO son postulaciones → no se pushean).
const TACTICAL_INVESTOR_ET = 'https://api.calendly.com/event_types/0049872a-7a3f-4e9c-a7d2-d9f88bfc1927';

// ─── Empresas (marca de cara al lead) ─────────────────────────────────────────
// Company es HOY solo un label (ver ADR 0001): ninguna lógica se bifurca por empresa. Sirve
// para agrupar/rotular. Ojo: empresa ≠ conexión — la conexión 30x hostea programas de DOS
// marcas (30X y EstadoX); Retia es una marca con su propia conexión.
export const COMPANIES = {
  '30x': '30X',
  estadox: 'EstadoX',
  retia: 'Retia',
};

// ▼▼▼ EDITA AQUÍ para sumar/mover/activar un programa ▼▼▼
export const PROGRAMS = {
  second_brain: {
    key: 'second_brain',
    label: 'AI Second Brain',
    // El título del meeting suele ser "Entrevista de Postulación Programa de Implementación
    // AI Second Brain", pero también "Second Brain <> Lead" → el hint corto cubre las dos.
    titleHints: ['second brain'],
    company: '30x',
    connection: '30x',
    eventType: SECOND_BRAIN_ET,
    pitch: {
      from: 'de Andrés Bilbao en 30X',
      program: 'programa de implementación de tecnología AI Second Brain para ti y tus proyectos',
    },
    materials: {
      brochure: 'https://drive.google.com/file/d/1ucwv-ANi7J7u6sXwAC4Azuj7qtI3kX_P/view',
      video: 'https://www.youtube.com/watch?v=DGA0nf0geN0',
    },
    active: true,
  },
  abogados: {
    key: 'abogados',
    label: 'IA para Abogados',
    titleHints: ['abogado'],
    company: 'estadox', // marca EstadoX, pero hosteado en la conexión 30x (empresa ≠ conexión)
    connection: '30x',
    eventType: ABOGADOS_ET,
    pitch: {
      from: 'de EstadoX',
      program: 'programa de IA para Abogados de EstadoX',
    },
    materials: {
      brochure: 'https://drive.google.com/file/d/1TN5HfX7r8ViM2JXuOmFOnvBSI3xyeLwR/view',
      video: 'https://www.youtube.com/watch?v=88W1z_M9tCg',
    },
    active: true,
  },
  linkedin: {
    key: 'linkedin',
    label: 'LinkedIn Sales',
    titleHints: ['linkedin'],
    company: '30x',
    connection: '30x',
    eventType: LINKEDIN_ET,
    pitch: {
      from: 'de 30X',
      program: 'programa de LinkedIn Sales de 30X',
    },
    materials: {
      brochure: 'https://drive.google.com/file/d/1MO5jP7rnbWKUyDWao3Q1-vfF1fzR-h3O/view',
      video: 'https://youtu.be/J9LDlmtQeHs',
    },
    active: true,
  },
  // Programas nuevos (2026-07-14). Todavía SIN video: el bloque de materiales se arma igual,
  // solo con el brochure (materialsBlock omite la línea que falte).
  developers: {
    key: 'developers',
    label: 'AI for Developers',
    // 'hardcore' NO es un rename: el programa se llama AI for Developers de cara al cliente
    // (confirmado por el jefe 2026-07-28), y por eso el label y el pitch de acá abajo se quedan
    // como están. "Hardcore AI" es cómo se nombran los DEALS puertas adentro de HubSpot: 672 de
    // los 685 del pipeline 887379064 en 30 días se llaman "‹lead› | Hardcore AI".
    // El hint existe solo como seguro: hoy no matchea nada (medido, 0 citas de closer con
    // "Hardcore" en el título en 21 días), pero si alguna vez ese naming interno se filtra al
    // título de una cita, Juanito la reconoce igual en vez de ignorarla EN SILENCIO — sin push
    // precall y fuera de la agenda del jefe, que es la clase de falla que no avisa.
    titleHints: ['developer', 'hardcore'],
    company: '30x',
    connection: '30x',
    eventType: DEVELOPERS_ET,
    pitch: {
      from: 'de 30X',
      program: 'programa de AI for Developers de 30X',
    },
    materials: {
      brochure: 'https://drive.google.com/file/d/1VEUK_yF1UxwrkiCQJP1VHFW-nG9d426I/view',
    },
    active: true,
  },
  operaciones: {
    key: 'operaciones',
    label: 'Operaciones Escalables con IA',
    titleHints: ['operaciones escalables'],
    company: '30x',
    connection: '30x',
    eventType: OPERACIONES_ET,
    pitch: {
      from: 'de 30X',
      program: 'programa de Operaciones Escalables con AI de 30X',
    },
    materials: {
      brochure: 'https://drive.google.com/file/d/16NbFnJq1gCYSfQA0a2sfLbGuEBxVc8Yp/view',
    },
    active: true,
  },
  // Instagram & TikTok (2026-07-16). El video es una landing de 30x.com, no YouTube.
  instagram: {
    key: 'instagram',
    label: 'Instagram & TikTok',
    titleHints: ['instagram'],
    company: '30x',
    connection: '30x',
    eventType: INSTAGRAM_ET,
    pitch: {
      from: 'de 30X',
      program: 'programa de Instagram & TikTok for Business de 30X',
    },
    materials: {
      brochure: 'https://drive.google.com/file/d/1VvP9kCMldKaVs3wwXHLZFk7I6Spu-JZS/view',
      video: 'https://30x.com/instagram-tiktok',
    },
    active: true,
  },
  // Retia — "De Cero a Tactical Investor". Lo VENDE Juan Pablo Vieira (la CARA, va en el pitch);
  // la marca de cara al lead es JP Tactical, la empresa interna es Retia. Los archivos NO se
  // adjuntan al push (es texto que el closer reenvía por wa.me): van como LINK. `order` fuerza
  // video ANTES del brochure para este programa (el resto usa el default brochure→video).
  tactical_investor: {
    key: 'tactical_investor',
    label: 'De Cero a Tactical Investor',
    // Retia no vive en el HubSpot conectado (es otra empresa): hoy este hint no matchea nada.
    // Se declara igual para que el día que entre, el programa quede cableado solo.
    titleHints: ['tactical investor'],
    company: 'retia',
    connection: 'retia',
    eventType: TACTICAL_INVESTOR_ET,
    pitch: {
      from: 'de Juan Pablo Vieira en JP Tactical',
      program: 'programa De Cero a Tactical Investor',
    },
    materials: {
      video: 'https://youtu.be/YQwmGRCBlF0',
      brochure: 'https://drive.google.com/file/d/1ec7QyeXF95r1mhEDbzaqxlZENJT_1mJ2/view?usp=drive_link',
      order: ['video', 'brochure'],
    },
    active: true,
  },
};
// ▲▲▲ EDITA AQUÍ ▲▲▲

// Un programa cuenta como activo salvo que declare active:false explícito. Default seguro:
// una entrada nueva que olvide el campo se comporta como antes (activa).
const isActive = (p) => p.active !== false;

// ─── Derivaciones (firma y salida idénticas a los mapas viejos) ────────────────

// Mapa plano event_type → programKey de TODOS los programas ACTIVOS. Los ETs son URIs únicas
// entre organizaciones, así que aplanar no puede colisionar.
export const eventTypeToProgram = () =>
  Object.fromEntries(Object.values(PROGRAMS).filter(isActive).map((p) => [p.eventType, p.key]));

// eventTypes { ET: programKey } de una Conexión (los que su poll debe mirar). Solo activos:
// un programa desactivado deja de pollearse sin borrar su copy. Devuelve objeto (los callers
// hacen Object.keys/Object.values sobre él).
export const eventTypesForConnection = (connectionKey) =>
  Object.fromEntries(
    Object.values(PROGRAMS)
      .filter((p) => isActive(p) && p.connection === connectionKey)
      .map((p) => [p.eventType, p.key])
  );

// Conexión (key) que hostea un programa, o null. Lookup por key: NO filtra por active (sirve
// para diagnóstico y para el guardrail de HubSpot aunque el programa esté desactivado).
export const connectionOfProgram = (programKey) => PROGRAMS[programKey]?.connection || null;

// Programa a partir del TÍTULO de un meeting de HubSpot. Las citas que se agendan fuera de
// Calendly (el closer las crea a mano en HubSpot) no traen event_type: lo único que las
// clasifica es cómo se llaman. Los títulos siguen el naming de los programas ("Entrevista de
// Postulación Programa X"), y un título que no matchea ningún programa NO es una call de venta
// — es una reunión interna ("30X <> Revisión con equipo de IT") y devolver null la descarta.
// Medido sobre 7 días de datos reales: 281 de 284 meetings de closers quedan clasificados, y
// los 3 restantes son justamente internas.
const normalizeTitle = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // sin acentos: "postulación" ≡ "postulacion"
    .replace(/\s+/g, ' ')
    .trim();

// Hints declarados en PROGRAMS; sin ellos cae al label, que suele estar contenido en el título.
const hintsOf = (p) => (p.titleHints?.length ? p.titleHints : [p.label]).map(normalizeTitle);

export function programFromTitle(title) {
  const t = normalizeTitle(title);
  if (!t) return null;
  for (const p of Object.values(PROGRAMS).filter(isActive)) {
    if (hintsOf(p).some((h) => h && t.includes(h))) return p.key;
  }
  return null;
}

// Rótulo corto, pitch y materiales por programKey. Incluyen TODOS los programas (el copy es
// estático e inofensivo si el programa está inactivo: sus callers no se ejecutan igual).
export const PROGRAM_LABELS = Object.fromEntries(
  Object.values(PROGRAMS).map((p) => [p.key, p.label])
);
export const PROGRAM_PITCH = Object.fromEntries(
  Object.values(PROGRAMS).map((p) => [p.key, p.pitch])
);
export const MATERIAL_LINKS = Object.fromEntries(
  Object.values(PROGRAMS).map((p) => [p.key, p.materials])
);
