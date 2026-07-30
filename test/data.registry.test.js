// test/data.registry.test.js
// F3b — test de equivalencia: lo que el seed dejó en la DB describe EXACTAMENTE lo mismo que
// los literales de src/calendly/. Es la condición previa a F3c (que el runtime lea de la DB):
// mientras esto sea verde, cambiar la fuente no puede cambiar el comportamiento.
// REQUIERE better-sqlite3 nativo → corre en Docker/VPS, igual que el resto de los data.*.
//
// La estrategia, y por qué no compara buildPrecallText directo: los mapas que el copy consume
// (PROGRAM_PITCH, MATERIAL_LINKS, PROGRAM_LABELS) son proyecciones PURAS de PROGRAMS. Si
// PROGRAMS es idéntico, el copy es byte-idéntico por construcción — que es la invariante que
// ADR 0001 protege. Comparar el insumo es más fuerte que comparar una salida: cubre también
// los programas que hoy no tienen cita agendada.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROGRAMS, COMPANIES, PROGRAM_LABELS, PROGRAM_PITCH, MATERIAL_LINKS, eventTypeToProgram } from '../src/calendly/programs.js';
import { ACCOUNTS, flagFromEnv } from '../src/calendly/accounts.js';
import { PEOPLE, IGNORED_CLOSERS } from '../src/calendly/closers.js';

const dir = mkdtempSync(join(tmpdir(), 'registry-'));
const DB_PATH = join(dir, 'test.sqlite');

let db;
let leido;
let R;

before(async () => {
  execFileSync('node', ['src/db/migrate.js'], { env: { ...process.env, DB_PATH }, stdio: 'pipe' });
  const Database = (await import('better-sqlite3')).default;
  db = new Database(DB_PATH);
  R = await import('../src/db/registry-read.js');
  leido = R.readRegistries(db);
});

after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

// ─── Canonicalización ────────────────────────────────────────────────────────
// Solo normaliza PRESENCIA de campos opcionales, nunca valores. `active` ausente significa
// activo (regla documentada en programs.js), y el seed la materializa como 1.
const canonProgram = (p) => {
  const out = { key: p.key, label: p.label };
  if (p.titleHints != null) out.titleHints = p.titleHints;
  out.company = p.company;
  out.connection = p.connection;
  out.eventType = p.eventType;
  out.pitch = p.pitch;
  if (p.materials != null) out.materials = p.materials;
  out.active = p.active !== false;
  return out;
};

// De ACCOUNTS solo se compara lo que el seed guarda. Las closures (token/orgUri/dryRun/push4)
// y `eventTypes` quedan fuera a propósito: las primeras no son serializables y el segundo se
// DERIVA de programs.js, así que compararlo mediría dos veces lo mismo.
const canonConnection = (c) => {
  const out = { key: c.key, label: c.label, env: c.env, hubspot: !!c.hubspot };
  if (c.sheets != null) out.sheets = c.sheets;
  return out;
};

const canonIdentity = (id) => {
  const out = { connection: id.connection, email: id.email.toLowerCase(), phone: id.phone };
  if (id.workLid != null) out.workLid = id.workLid;
  if (id.hubspotEmail != null) out.hubspotEmail = id.hubspotEmail.toLowerCase();
  return out;
};

// ─── Equivalencia de las estructuras crudas ──────────────────────────────────

test('COMPANIES: DB ≡ código', () => {
  assert.deepStrictEqual(leido.COMPANIES, COMPANIES);
});

test('PROGRAMS: DB ≡ código', () => {
  const esperado = Object.fromEntries(Object.entries(PROGRAMS).map(([k, p]) => [k, canonProgram(p)]));
  assert.deepStrictEqual(leido.PROGRAMS, esperado);
});

test('PROGRAMS conserva el ORDEN de declaración', () => {
  // No es cosmético: programFromTitle devuelve el PRIMER programa cuyo hint matchea el título.
  // Un orden distinto puede clasificar una cita a otro programa → otro copy, otro pitch.
  assert.deepStrictEqual(Object.keys(leido.PROGRAMS), Object.keys(PROGRAMS));
});

test('CONNECTIONS: DB ≡ código', () => {
  const esperado = Object.fromEntries(Object.entries(ACCOUNTS).map(([k, c]) => [k, canonConnection(c)]));
  assert.deepStrictEqual(leido.CONNECTIONS, esperado);
});

test('PEOPLE: DB ≡ código (personas, identidades y su orden)', () => {
  const esperado = Object.fromEntries(
    Object.entries(PEOPLE).map(([k, p]) => [k, { name: p.name, identities: p.identities.map(canonIdentity) }])
  );
  assert.deepStrictEqual(leido.PEOPLE, esperado);
  assert.deepStrictEqual(Object.keys(leido.PEOPLE), Object.keys(PEOPLE));
});

test('IGNORED_CLOSERS: DB ≡ código', () => {
  const esperado = new Set([...IGNORED_CLOSERS].map((e) => e.toLowerCase()));
  assert.deepStrictEqual(leido.IGNORED_CLOSERS, esperado);
});

// ─── Los emails del roster ya vienen en minúsculas ───────────────────────────

test('los emails del roster están en minúsculas en el código', () => {
  // El seed los baja a minúsculas porque así es la llave de CLOSERS. Si un email del literal
  // tuviera mayúsculas, DB y código dejarían de describir lo mismo y este test lo diría acá,
  // en vez de que F3c fallara un lookup en producción.
  for (const [key, persona] of Object.entries(PEOPLE)) {
    for (const id of persona.identities) {
      assert.equal(id.email, id.email.toLowerCase(), `${key}: ${id.email}`);
      if (id.hubspotEmail) {
        assert.equal(id.hubspotEmail, id.hubspotEmail.toLowerCase(), `${key}: ${id.hubspotEmail}`);
      }
    }
  }
});

// ─── Los derivados que consume el copy ───────────────────────────────────────
// Reproducidos desde la lectura de DB con las MISMAS proyecciones de una línea que hace
// programs.js. Redundante con "PROGRAMS ≡ código" a propósito: son los mapas que el roadmap
// nombra explícitamente y los que buildPrecallText toca.

test('los mapas de copy derivados de la DB son idénticos', () => {
  const p = Object.values(leido.PROGRAMS);
  assert.deepStrictEqual(Object.fromEntries(p.map((x) => [x.key, x.label])), PROGRAM_LABELS);
  assert.deepStrictEqual(Object.fromEntries(p.map((x) => [x.key, x.pitch])), PROGRAM_PITCH);
  assert.deepStrictEqual(Object.fromEntries(p.map((x) => [x.key, x.materials])), MATERIAL_LINKS);
});

test('eventTypeToProgram derivado de la DB es idéntico', () => {
  const desdeDb = Object.fromEntries(
    Object.values(leido.PROGRAMS).filter((x) => x.active).map((x) => [x.eventType, x.key])
  );
  assert.deepStrictEqual(desdeDb, eventTypeToProgram());
});

// ─── La metadata declarativa concuerda con las closures ──────────────────────
// accounts.js mantiene HOY las dos representaciones (ver el comentario de flagFromEnv): las
// closures son el runtime, `env` es lo que el seed guarda. Esto es la red contra que driftéen.

test('env.dryRun/push4 producen el mismo valor que las closures, con y sin la variable', () => {
  const original = { ...process.env };
  try {
    for (const c of Object.values(ACCOUNTS)) {
      for (const campo of ['dryRun', 'push4']) {
        const envName = c.env[campo];
        const flag = flagFromEnv(envName, c.env[`${campo}Default`]);
        for (const valor of ['true', 'false', undefined]) {
          if (envName) {
            if (valor === undefined) delete process.env[envName];
            else process.env[envName] = valor;
          }
          assert.equal(flag(), c[campo](), `${c.key}.${campo} con ${envName || '(fijo)'}=${valor}`);
          if (!envName) break; // sin variable el valor es fijo: un solo caso alcanza
        }
      }
    }
  } finally {
    process.env = original;
  }
});

test('env.token y env.orgUri nombran la variable que la closure realmente lee', () => {
  const original = { ...process.env };
  try {
    for (const c of Object.values(ACCOUNTS)) {
      process.env[c.env.token] = `centinela-${c.key}`;
      assert.equal(c.token(), `centinela-${c.key}`, `${c.key}.token`);

      // Sin override, orgUri cae al default que el seed guardó.
      delete process.env[c.env.orgUri];
      assert.equal(c.orgUri(), c.env.orgUriDefault, `${c.key}.orgUri default`);
      process.env[c.env.orgUri] = `https://api.calendly.com/organizations/centinela-${c.key}`;
      assert.equal(c.orgUri(), `https://api.calendly.com/organizations/centinela-${c.key}`, `${c.key}.orgUri override`);
    }
  } finally {
    process.env = original;
  }
});

// ─── Idempotencia ────────────────────────────────────────────────────────────

test('correr el seed de nuevo no duplica ni modifica nada', async () => {
  const { seedRegistries } = await import('../src/db/registry-seed.js');
  const antes = R.readRegistries(db);
  const resumen = seedRegistries(db);
  assert.deepStrictEqual(
    resumen,
    { companies: 0, connections: 0, programs: 0, closers: 0, closer_identities: 0, ignored_closers: 0 },
    'una tabla con filas se salta entera'
  );
  assert.deepStrictEqual(R.readRegistries(db), antes);
});

test('el seed NO pisa una edición hecha desde el dashboard', async () => {
  // La regla que hace que F3d sea posible: el código es la SEMILLA, no el dueño permanente.
  const { seedRegistries } = await import('../src/db/registry-seed.js');
  db.prepare("UPDATE programs SET label = 'Editado a mano' WHERE key = 'linkedin'").run();
  seedRegistries(db);
  assert.equal(R.readPrograms(db).linkedin.label, 'Editado a mano');
  db.prepare('UPDATE programs SET label = ? WHERE key = ?').run(PROGRAMS.linkedin.label, 'linkedin');
});

// ─── Invariante del roster ───────────────────────────────────────────────────

test('un teléfono = una PERSONA (lo que rompería el opt-in)', () => {
  // Misma invariante que calendly.closers.test.js, comprobada sobre la DB: dos identidades
  // pueden compartir teléfono si son la misma persona (Sebastian Salazar, 30x + retia); dos
  // PERSONAS distintas con el mismo número se pisarían el opt-in (`calendly_optins.phone` PK).
  const filas = db.prepare('SELECT closer_key, phone FROM closer_identities').all();
  const porTelefono = new Map();
  for (const f of filas) {
    const previo = porTelefono.get(f.phone);
    assert.ok(
      previo === undefined || previo === f.closer_key,
      `el teléfono ${f.phone} lo comparten dos personas: ${previo} y ${f.closer_key}`
    );
    porTelefono.set(f.phone, f.closer_key);
  }
});

test('cada identidad apunta a una conexión y una empresa que existen', () => {
  const conexiones = new Set(Object.keys(leido.CONNECTIONS));
  const empresas = new Set(Object.keys(leido.COMPANIES));
  for (const [key, p] of Object.entries(leido.PEOPLE)) {
    for (const id of p.identities) {
      assert.ok(conexiones.has(id.connection), `${key}: conexión "${id.connection}" no existe`);
    }
  }
  for (const p of Object.values(leido.PROGRAMS)) {
    assert.ok(conexiones.has(p.connection), `${p.key}: conexión "${p.connection}" no existe`);
    assert.ok(empresas.has(p.company), `${p.key}: empresa "${p.company}" no existe`);
  }
});

test('ningún closer del roster está además en la lista de ignorados', () => {
  // Exactamente el error del §18.AV: equipo@ttrading.co estuvo en las dos listas y sus citas
  // caían en el `continue` silencioso de isIgnoredCloser. Una semana sin pushes, sin una alerta.
  for (const [key, p] of Object.entries(leido.PEOPLE)) {
    for (const id of p.identities) {
      assert.ok(!leido.IGNORED_CLOSERS.has(id.email), `${key}: ${id.email} está en el roster Y en ignorados`);
    }
  }
});
