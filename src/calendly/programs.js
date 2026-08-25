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
// ⚠️ MIGRADO 2026-08-25. EstadoX dejó el Calendly de 30X y abrió el suyo (comunidad@estadox.com,
// usuario creado el 2026-07-24T18:04Z). El ET viejo de esta línea era
// f8d123ac-364b-47f9-a446-1316fdf37b08, de la conexión '30x' — desde el 24-jul no recibe una sola
// reserva, y como el poll no distingue "cero citas" de "estoy mirando el ET equivocado", el
// programa estuvo un mes sin pushes y sin una sola alerta (mismo silencio que el buzón-rol de
// Retia, ver closers.js). El síntoma visible fue otro: la línea "📅 Bookearon Calendly" del
// reporte de las 8pm marcando 0 todos los días.
//
// El ET nuevo es POOL (`pooling_type: multi_pool`, `profile: null`) ⇒ NO sale en /event_types.
// Lo que SÍ sale de esa org es 0a1d4a2c-cc20-4b7b-bf72-8a7e1cc35172, un ET *solo* con el nombre
// IDÉNTICO ("Postulación Programa IA para Abogados | EstadoX", slug comunidad-estadox/30min).
// Cablear ese señuelo no da error: devuelve cero reservas para siempre. Este UUID se sacó de las
// reservas reales (GET /scheduled_events → event_type), que es la única fuente confiable.
const ABOGADOS_ET = 'https://api.calendly.com/event_types/83bb87b3-0c73-43ea-a618-196a74512eab';
const LINKEDIN_ET = 'https://api.calendly.com/event_types/96ddf036-9174-459c-be73-b248ad95be13';
const DEVELOPERS_ET = 'https://api.calendly.com/event_types/dff3e48a-4859-417a-98fb-822048aef5d9';
const OPERACIONES_ET = 'https://api.calendly.com/event_types/8462e92a-8210-4bb2-8e2b-583aa3c3d877';
const INSTAGRAM_ET = 'https://api.calendly.com/event_types/d33075cb-d349-43ef-be43-6f80f9c5da03';
// Retia — único ET de venta de ese Calendly (los otros tipos: Revisión de Portafolio, Asesoría,
// etc., NO son postulaciones → no se pushean).
const TACTICAL_INVESTOR_ET = 'https://api.calendly.com/event_types/0049872a-7a3f-4e9c-a7d2-d9f88bfc1927';
// ComunicArte — derivado 2026-08-25 contra la cuenta real (219 citas en 90d atrás/45d adelante).
// ⚠️ ES POOL (`pooling_type: round_robin`, `profile: null`, sin slug) ⇒ NO sale en /event_types.
// Se sacó del campo `event_type` de las reservas reales, igual que EstadoX y Tactical Investor.
//
// ⚠️ Y ACÁ HAY UN SEÑUELO, el mismo patrón que costó un mes de pushes en EstadoX: la org SÍ expone
// por /event_types un ET *solo* llamado "Postulación Comunicarte"
// (44920fd3-a7ce-4f07-b293-d1bf434842be, slug eventoscomunicarte-info/postulacion-comunicarte).
// Cablear ESE no da error: tiene 36 reservas históricas, CERO desde el 2026-07-29 y CERO futuras
// — o sea, silencio permanente que el poll no puede distinguir de "no hubo citas".
// El bueno es este: 183 reservas y las 4 futuras, con los dos nombres que la marca fue usando
// ("Postulación Método Comunicarte" y "Postulación Evento Comunicarte" — mismo ET, el nombre del
// evento no clasifica nada, el event_type sí).
const COMUNICARTE_ET = 'https://api.calendly.com/event_types/098ad9d0-5268-4156-afc1-b371a42f6945';

// ─── Empresas (marca de cara al lead) ─────────────────────────────────────────
// Company es HOY solo un label (ver ADR 0001): ninguna lógica se bifurca por empresa. Sirve
// para agrupar/rotular. Ojo: empresa ≠ conexión — la conexión 30x hostea programas de DOS
// marcas (30X y EstadoX); Retia es una marca con su propia conexión.
export const COMPANIES = {
  '30x': '30X',
  estadox: 'EstadoX',
  retia: 'Retia',
  // ComunicArte (2026-08-25). Marca propia con su PROPIO Calendly. La opera Retia —su material
  // vive en el Drive de administrativa@retiagrowth.com y sus closers llenan un Sheet que hoy
  // cuelga de la conexión `retia`—, pero de cara al lead la marca es ComunicArte, y ese es el
  // eje que `company` rotula (ver ADR 0001). Mismo caso que EstadoX bajo 30X.
  comunicarte: 'ComunicArte',
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
    company: 'estadox',
    // Desde 2026-08-25 la marca y la conexión COINCIDEN. Antes era company:'estadox' sobre
    // connection:'30x', y ESTE programa era el único ejemplo vivo de empresa ≠ conexión — el caso
    // que motivó separar los dos conceptos en el ADR 0001.
    // ⚠️ Que hoy TODOS los programas tengan company === connection NO significa que los campos
    // sobren: son ejes distintos (de quién es la marca vs. de quién es el Calendly) y basta que
    // EstadoX vuelva a vender un programa hosteado en el Calendly de 30X para que se separen otra
    // vez. No colapsarlos en uno solo.
    connection: 'estadox',
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
    // Copy dictado por el jefe (2026-07-28). Dos cosas a propósito, distintas del resto de
    // programas: el nombre va SIN "de" delante y SIN "de 30X" al final (la marca ya se dijo en
    // "Por acá <closer> de 30X"), y dice "IA", no "AI" — que es como se llama el programa.
    pitch: {
      from: 'de 30X',
      program: 'programa Operaciones Escalables con IA',
    },
    // ÚNICO programa que no manda links en el push (decisión del jefe, 2026-07-28). Los dos
    // flags son por-programa, como `order`: sin ellos materialsBlock se comporta igual que
    // siempre → los otros 6 programas no se enteran de nada de esto.
    materials: {
      // El link NO está muerto: se conserva a propósito. El brochure sigue existiendo y sigue
      // siendo el de este programa; lo único que cambió es que dejó de viajar en el push.
      // Para volver a mandarlo: borrar `sendLinks: false`, nada más.
      brochure: 'https://drive.google.com/file/d/16NbFnJq1gCYSfQA0a2sfLbGuEBxVc8Yp/view',
      sendLinks: false, // el closer entrega el material por su cuenta
      boldHeader: true, // la línea de materiales va en negrita
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
      // ⚠️ NO es un duplicado del video que vive dentro de la carpeta de abajo. DECIDIDO por el
      // jefe (2026-08-21): los dos conviven en el push a propósito — el de YouTube abre en un clic
      // y el .mp4 de Drive viaja con el resto del material. Al que le sobre una línea acá: no
      // sobra, ya se preguntó.
      video: 'https://youtu.be/YQwmGRCBlF0',
      // ⚠️ ÚNICO programa cuyo `brochure` es una CARPETA de Drive, no un archivo. Es el link
      // OFICIAL que mandó Retia (confirmado por el jefe 2026-08-21) y contiene el paquete
      // completo del programa: el brochure de la cohorte del 29-sep + el video en .mp4.
      // NO reemplazar por el link del PDF de adentro: perdería el video, y Retia actualiza
      // el contenido de la carpeta sin avisarnos — apuntar a la carpeta es lo que hace que
      // el push siga sirviendo el material vigente sin tocar el repo.
      // El file ID viejo (1ec7QyeXF95…) respondía 401 sin autenticar y ni siquiera es legible
      // con nuestra cuenta (404 por API): vive en un Drive de Retia fuera de nuestro alcance,
      // así que no aplicó el patrón "conservar el file ID" de §18.BK — no había qué conservar.
      // Verificado 200 sin autenticar antes de cablearlo.
      brochure: 'https://drive.google.com/drive/folders/18DJsMV8yLFRyov1iGhAyMo8nmHWUmgJ3?usp=sharing',
      order: ['video', 'brochure'],
    },
    active: true,
  },
  // ComunicArte — "Método Comunicarte" (2026-08-25). Conexión PROPIA (Calendly de
  // info@eventoscomunicarte.com). Arranca en dry-run: ver accounts.js.
  //
  // ⚠️ PENDIENTE BLOQUEANTE AL 2026-08-25 — los leads de este ET llegan SIN TELÉFONO. El ET
  // declara una pregunta `phone_number` requerida ("Ingrese su número telefónico"), pero en las
  // 30 reservas muestreadas —incluidas las 4 futuras y las creadas después de que la pregunta se
  // agregó (ET actualizado el 2026-07-27)— `text_reminder_number` viene null y
  // `questions_and_answers` viene vacío. Sin teléfono no hay link wa.me: `buildPush3Message` y
  // `buildDigestMessage` degradan a "(mándalo manual)" y el push pierde todo su valor.
  // ComunicArte NO está en el HubSpot que Juanito tiene conectado (hubspot:false), así que
  // tampoco hay fallback de teléfono por CRM. Se resuelve del lado de Calendly, no acá.
  comunicarte: {
    key: 'comunicarte',
    label: 'Método Comunicarte',
    titleHints: ['comunicarte'],
    company: 'comunicarte',
    connection: 'comunicarte',
    eventType: COMUNICARTE_ET,
    // Copy DERIVADO del nombre del event_type ("Postulación Método Comunicarte"), no dictado por
    // el jefe todavía. La conexión arranca muda justamente para que nada de esto le llegue a un
    // lead antes de que él lo confirme.
    pitch: {
      from: 'de ComunicArte',
      program: 'programa Método Comunicarte',
    },
    // Los dos archivos de la carpeta oficial que mandó ComunicArte, enlazados POR SEPARADO
    // (patrón de los 6 programas de 30X), no como carpeta: la carpeta tiene exactamente estos
    // dos archivos, así que apuntar a cada uno no pierde nada y le da al lead el 🎥 y el 📄 en
    // vez de un directorio. Ambos verificados 200 sin autenticar y con permiso
    // `anyoneWithLink: reader` antes de cablearlos.
    // Carpeta de origen: https://drive.google.com/drive/folders/1OPBf5UufbzREVSwVmNIVXYH_cfeuPVQq
    materials: {
      brochure: 'https://drive.google.com/file/d/1Wy46CusuklF_eNfZuuTtX_NVTKNZ3cVs/view',
      video: 'https://drive.google.com/file/d/1BCDo_zovnrCZDQqvbuxdcKGtzgWjKtSi/view',
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
