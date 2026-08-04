// src/db/registry-read.js
// Lee las tablas de registries y las devuelve con la MISMA FORMA que los literales de
// src/calendly/. Es el reverso exacto de registry-seed.js.
//
// En F3a nadie lo llama en runtime: existe para que el test de equivalencia
// (test/db.registry.test.js) pueda comparar "lo que quedó en la DB" contra "lo que dice el
// código". Ese test es lo único que hace verificable al seed, y es la condición previa a F3c.
//
// Por qué devuelve las estructuras CRUDAS (PROGRAMS, PEOPLE, …) y no los mapas derivados
// (PROGRAM_PITCH, CLOSERS, CLOSER_LIDS, …): los derivados son proyecciones puras de las crudas.
// Si lo crudo es idéntico, TODO derivado lo es por construcción — incluido el copy que
// buildPrecallText arma, que es la invariante que ADR 0001 protege. Reimplementar acá las
// derivaciones daría una segunda copia de esa lógica destinada a divergir; comparar el insumo
// es más fuerte y más barato.
//
// Los campos opcionales se OMITEN cuando la columna es NULL (en vez de emitir `undefined`):
// una llave presente con valor undefined no es deep-equal a una llave ausente, y el literal no
// la declara.

const parse = (v) => (v == null ? null : JSON.parse(v));

// Agrega `key: value` solo si value no es null/undefined.
const conOpcional = (obj, key, value) => {
  if (value != null) obj[key] = value;
  return obj;
};

export function readCompanies(db) {
  const filas = db.prepare('SELECT key, label FROM companies ORDER BY sort_order').all();
  return Object.fromEntries(filas.map((f) => [f.key, f.label]));
}

export function readPrograms(db) {
  const filas = db.prepare(`
    SELECT key, label, title_hints, company, connection, event_type,
           pitch_from, pitch_program, materials, active
    FROM programs ORDER BY sort_order
  `).all();
  return Object.fromEntries(filas.map((f) => {
    const p = { key: f.key, label: f.label };
    conOpcional(p, 'titleHints', parse(f.title_hints));
    p.company = f.company;
    p.connection = f.connection;
    p.eventType = f.event_type;
    p.pitch = { from: f.pitch_from, program: f.pitch_program };
    conOpcional(p, 'materials', parse(f.materials));
    p.active = f.active === 1;
    return [f.key, p];
  }));
}

// Conexiones. `env` es la metadata declarativa; las closures (token/orgUri/dryRun/push4) NO se
// reconstruyen acá — quien las necesite las arma con flagFromEnv de accounts.js. F3a no las usa.
export function readConnections(db) {
  const filas = db.prepare(`
    SELECT key, label, token_env, org_uri_env, org_uri_default, dry_run_env, dry_run_default,
           push4_env, push4_default, hubspot, sheets
    FROM connections ORDER BY sort_order
  `).all();
  return Object.fromEntries(filas.map((f) => {
    const c = {
      key: f.key,
      label: f.label,
      env: {
        token: f.token_env,
        orgUri: f.org_uri_env,
        orgUriDefault: f.org_uri_default,
        dryRun: f.dry_run_env,
        dryRunDefault: f.dry_run_default === 1,
        push4: f.push4_env,
        push4Default: f.push4_default === 1,
      },
      hubspot: f.hubspot === 1,
    };
    conOpcional(c, 'sheets', parse(f.sheets));
    return [f.key, c];
  }));
}

// Personas con sus identidades, en la forma de PEOPLE.
export function readPeople(db) {
  const personas = db.prepare('SELECT key, name FROM closers ORDER BY sort_order').all();
  const ids = db.prepare(`
    SELECT closer_key, connection, email, phone, work_lid, hubspot_email
    FROM closer_identities ORDER BY sort_order
  `).all();

  const porPersona = new Map(personas.map((p) => [p.key, []]));
  for (const id of ids) {
    const identidad = { connection: id.connection, email: id.email, phone: id.phone };
    conOpcional(identidad, 'workLid', id.work_lid);
    conOpcional(identidad, 'hubspotEmail', id.hubspot_email);
    // Una identidad cuya persona no existe es un dato roto, no algo que valga silenciar:
    // significaría que alguien vació `closers` sin vaciar `closer_identities`.
    if (!porPersona.has(id.closer_key)) {
      throw new Error(`identidad huérfana: ${id.email} apunta a la persona "${id.closer_key}", que no existe`);
    }
    porPersona.get(id.closer_key).push(identidad);
  }

  return Object.fromEntries(personas.map((p) => [p.key, { name: p.name, identities: porPersona.get(p.key) }]));
}

export function readIgnoredClosers(db) {
  const filas = db.prepare('SELECT email FROM ignored_closers ORDER BY sort_order').all();
  return new Set(filas.map((f) => f.email));
}

export function readRegistries(db) {
  return {
    COMPANIES: readCompanies(db),
    PROGRAMS: readPrograms(db),
    CONNECTIONS: readConnections(db),
    PEOPLE: readPeople(db),
    IGNORED_CLOSERS: readIgnoredClosers(db),
  };
}
