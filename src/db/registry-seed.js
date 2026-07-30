// src/db/registry-seed.js
// Siembra las tablas de registries (F3a) desde los literales de src/calendly/. Lo llama
// migrate.js, envuelto en try/catch — ver el comentario de la sección 3 de ese archivo.
//
// Dos reglas que definen esta pieza:
//   1. **Solo siembra tablas VACÍAS.** Una tabla con filas se salta entera, sin comparar ni
//      actualizar. Así el seed es idempotente y —más importante— nunca pisa una edición hecha
//      desde el dashboard en F3d. El código es la semilla, no el dueño permanente del dato.
//   2. **No duplica los literales.** Importa PROGRAMS/ACCOUNTS/PEOPLE y los transcribe. Si
//      alguien agrega un programa en programs.js, el seed de una base nueva ya lo incluye sin
//      tocar este archivo.
//
// El orden de inserción preserva `sort_order` = orden de declaración en el literal, que NO es
// cosmético: `programFromTitle` devuelve el primer programa cuyo hint matchea.
//
// Lo que NO hace: escribir secretos. De cada Conexión guarda el NOMBRE de su env var.

import { PROGRAMS, COMPANIES } from '../calendly/programs.js';
import { ACCOUNTS } from '../calendly/accounts.js';
import { PEOPLE, IGNORED_CLOSERS } from '../calendly/closers.js';

const vacia = (db, tabla) => db.prepare(`SELECT COUNT(*) AS n FROM ${tabla}`).get().n === 0;

// JSON.stringify(undefined) es undefined, que better-sqlite3 rechaza como parámetro.
const json = (v) => (v == null ? null : JSON.stringify(v));

export function seedRegistries(db) {
  const resumen = { companies: 0, connections: 0, programs: 0, closers: 0, closer_identities: 0, ignored_closers: 0 };

  // Todo o nada: si una tabla falla a mitad, ninguna queda a medias.
  db.transaction(() => {
    if (vacia(db, 'companies')) {
      const ins = db.prepare('INSERT INTO companies (key, label, sort_order) VALUES (?, ?, ?)');
      Object.entries(COMPANIES).forEach(([key, label], i) => {
        ins.run(key, label, i);
        resumen.companies++;
      });
    }

    if (vacia(db, 'connections')) {
      const ins = db.prepare(`
        INSERT INTO connections
          (key, label, token_env, org_uri_env, org_uri_default, dry_run_env, dry_run_default,
           push4_env, push4_default, hubspot, sheets, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      Object.values(ACCOUNTS).forEach((c, i) => {
        // `env` es la metadata declarativa que accounts.js expone justamente para esto. Sin
        // ella no habría cómo saber el nombre de la variable: una closure no es introspectable.
        const e = c.env;
        if (!e) throw new Error(`la conexión "${c.key}" no declara metadata \`env\` (ver accounts.js)`);
        ins.run(
          c.key, c.label, e.token, e.orgUri ?? null, e.orgUriDefault,
          e.dryRun ?? null, e.dryRunDefault ? 1 : 0,
          e.push4 ?? null, e.push4Default ? 1 : 0,
          c.hubspot ? 1 : 0, json(c.sheets), i
        );
        resumen.connections++;
      });
    }

    if (vacia(db, 'programs')) {
      const ins = db.prepare(`
        INSERT INTO programs
          (key, label, title_hints, company, connection, event_type,
           pitch_from, pitch_program, materials, active, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      Object.values(PROGRAMS).forEach((p, i) => {
        ins.run(
          p.key, p.label, json(p.titleHints), p.company, p.connection, p.eventType,
          p.pitch.from, p.pitch.program, json(p.materials),
          // `active !== false` y no `!!active`: un programa que omita el campo cuenta como
          // activo, que es el default seguro del literal.
          p.active !== false ? 1 : 0, i
        );
        resumen.programs++;
      });
    }

    // Personas e identidades se siembran juntas: una identidad sin su persona no sirve de nada.
    // Se decide por `closers` para no quedar con identidades huérfanas si alguien vació una sola.
    if (vacia(db, 'closers')) {
      const insP = db.prepare('INSERT INTO closers (key, name, sort_order) VALUES (?, ?, ?)');
      const insI = db.prepare(`
        INSERT INTO closer_identities
          (closer_key, connection, email, phone, work_lid, hubspot_email, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      let orden = 0;
      Object.entries(PEOPLE).forEach(([key, person], i) => {
        insP.run(key, person.name, i);
        resumen.closers++;
        for (const id of person.identities) {
          // El email va en minúsculas porque así es la llave de CLOSERS: guardarlo con otra
          // caja acá haría que el lookup por email fallara cuando F3c lea de la tabla.
          insI.run(
            key, id.connection, id.email.toLowerCase(), id.phone,
            id.workLid ?? null, id.hubspotEmail?.toLowerCase() ?? null, orden++
          );
          resumen.closer_identities++;
        }
      });
    }

    if (vacia(db, 'ignored_closers')) {
      const ins = db.prepare('INSERT INTO ignored_closers (email, note, sort_order) VALUES (?, ?, ?)');
      // El Set no guarda el porqué de cada uno: eso vive en los comentarios de closers.js.
      // Se siembra `note` en NULL a propósito en vez de inventar razones — el dashboard lo
      // muestra vacío y quien sepa la razón la escribe, en vez de heredar una adivinada.
      [...IGNORED_CLOSERS].forEach((email, i) => {
        ins.run(String(email).toLowerCase(), null, i);
        resumen.ignored_closers++;
      });
    }
  })();

  return resumen;
}
