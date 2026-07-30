// dashboard/server/selftest-escrituras.js
// Ejercita la capa de ESCRITURA (F2) de verdad: valida los rechazos y hace round-trips
// completos (crear → modificar → cancelar) para probar que los argumentos que le pasamos
// a cada función de src/db/index.js son los que esa función espera.
//
// Existe porque en el Mac no hay binding de better-sqlite3 para Node 26: la única
// verificación real es dentro del contenedor. Y como esto ESCRIBE, corre siempre sobre
// una COPIA — hay dos guardas abajo que se niegan a tocar la base viva.
//
// Uso (en `juanito-dash`: /app/dashboard existe solo ahí — ver la cabecera de selftest.js):
//   docker exec juanito-dash node -e "const D=require('better-sqlite3');\
//     new D('/app/data/brain.sqlite',{readonly:true}).exec(\"VACUUM INTO '/tmp/copia.sqlite'\")"
//   docker exec -e DB_PATH=/tmp/copia.sqlite -e DASH_WRITES=todo \
//     juanito-dash node /app/dashboard/server/selftest-escrituras.js

import { listAuthorizedGroups } from '../../src/db/index.js';
import { ACCIONES, MalaPeticion, ejecutar, tabsHabilitados } from './actions.js';
import * as Q from './queries.js';

// ─── Guardas: nunca sobre la base viva ────────────────────────────────────────

const DB = process.env.DB_PATH || '';
if (!DB) {
  console.error('Falta DB_PATH. Este script escribe: apuntalo a una COPIA de la base.');
  process.exit(1);
}
if (DB.includes('/app/data/') || DB.endsWith('brain.sqlite')) {
  console.error(`DB_PATH=${DB} parece la base VIVA. Hacé un VACUUM INTO y apuntá a la copia.`);
  process.exit(1);
}
if (tabsHabilitados().length !== Object.keys(ACCIONES).length) {
  console.error('Corré con DASH_WRITES=todo para poder ejercitar los ocho tabs.');
  process.exit(1);
}

let fallos = 0;
const ok = (nombre, extra = '') => console.log(`  ok    ${nombre.padEnd(34)} ${extra}`);
const falla = (nombre, motivo) => {
  fallos++;
  console.log(`  FALLA ${nombre.padEnd(34)} ${motivo}`);
};

function esperar(nombre, condicion, detalle = '') {
  condicion ? ok(nombre, detalle) : falla(nombre, detalle || 'condición falsa');
}

// ─── 1. Toda acción rechaza un cuerpo vacío ───────────────────────────────────
// Barato y sorprendentemente útil: recorre la tabla de acciones entera, así que una
// acción nueva sin validación aparece acá sin que nadie escriba un test.

console.log('\n── Validación (cuerpo vacío debe dar 400) ───────────');
for (const [tab, grupo] of Object.entries(ACCIONES)) {
  for (const accion of Object.keys(grupo)) {
    try {
      ejecutar(tab, accion, {});
      falla(`${tab}/${accion}`, 'aceptó un cuerpo vacío');
    } catch (err) {
      if (err instanceof MalaPeticion) ok(`${tab}/${accion}`, err.message.slice(0, 60));
      else falla(`${tab}/${accion}`, `explotó con ${err.constructor.name}: ${err.message}`);
    }
  }
}

// ─── 2. Round-trips reales ────────────────────────────────────────────────────

console.log('\n── Toggles ──────────────────────────────────────────');
{
  const antes = Q.toggles();
  ejecutar('toggles', 'calendly', { pausado: !antes.calendlyPausado });
  esperar(
    'calendly cambia',
    Q.toggles().calendlyPausado === !antes.calendlyPausado,
    `${antes.calendlyPausado} → ${!antes.calendlyPausado}`
  );
  ejecutar('toggles', 'calendly', { pausado: antes.calendlyPausado });
  esperar('calendly restaurado', Q.toggles().calendlyPausado === antes.calendlyPausado);

  ejecutar('toggles', 'dm', { activo: !antes.dmAprobacion });
  esperar('dm cambia', Q.toggles().dmAprobacion === !antes.dmAprobacion);
  ejecutar('toggles', 'dm', { activo: antes.dmAprobacion });

  const c = antes.closers[0];
  if (!c) ok('pausa por closer', 'sin closers en el registry, se salta');
  else {
    ejecutar('toggles', 'closer', { email: c.email, pausado: !c.pausado });
    const despues = Q.toggles().closers.find((x) => x.email === c.email);
    esperar('pausa por closer', despues.pausado === !c.pausado, c.email);
    ejecutar('toggles', 'closer', { email: c.email, pausado: c.pausado });
  }
}

console.log('\n── Recordatorios (crear → posponer → cancelar) ──────');
{
  const cuando = new Date(Date.now() + 86400000)
    .toLocaleString('sv', { timeZone: process.env.TZ || 'America/Bogota' });
  const r = ejecutar('recordatorios', 'crear', { texto: 'selftest de escrituras', cuando });
  esperar('crear', r.ok && r.n > 0, `id=${r.n}`);
  if (r.ok) {
    const otro = cuando.replace(/\d{2}:\d{2}:\d{2}$/, '23:59:00');
    esperar('posponer', ejecutar('recordatorios', 'posponer', { id: r.n, cuando: otro }).ok);
    esperar('cancelar', ejecutar('recordatorios', 'cancelar', { id: r.n }).ok);
    // Ya cancelado: la segunda vez el scope por status='pending' no encuentra nada y la
    // acción lo dice en vez de mentir con un éxito.
    try {
      ejecutar('recordatorios', 'cancelar', { id: r.n });
      falla('cancelar dos veces', 'no avisó que ya no estaba pendiente');
    } catch (err) {
      esperar('cancelar dos veces', err instanceof MalaPeticion, err.message.slice(0, 50));
    }
  }
}

console.log('\n── Programados (crear → cancelar) ───────────────────');
{
  const g = listAuthorizedGroups()[0];
  if (!g) ok('crear', 'sin grupos autorizados en la copia, se salta');
  else {
    const r = ejecutar('programados', 'crear', {
      grupoId: g.group_id,
      dias: [1, 3],
      hora: '09:30',
      texto: 'selftest de escrituras',
    });
    esperar('crear', r.ok, `id=${r.n} en "${g.group_name}"`);
    if (r.ok) {
      const fila = Q.programados().find((m) => m.id === r.n);
      esperar('días y hora guardados', fila?.days === '1,3' && fila?.time_hm === '09:30', `${fila?.days} ${fila?.time_hm}`);
      esperar('cancelar', ejecutar('programados', 'cancelar', { id: r.n }).ok);
      esperar('cancelar dos veces no aplica', !ejecutar('programados', 'cancelar', { id: r.n }).ok);
    }
    // Default-deny: un grupo no autorizado se rechaza igual que en el bot.
    try {
      ejecutar('programados', 'crear', { grupoId: 'inventado@g.us', dias: [1], hora: '09:00', texto: 'x' });
      falla('default-deny de grupos', 'aceptó un grupo no autorizado');
    } catch (err) {
      esperar('default-deny de grupos', err instanceof MalaPeticion, err.message.slice(0, 50));
    }
  }
}

console.log('\n── Grupos (persona → borrar) ────────────────────────');
{
  const g = listAuthorizedGroups()[0];
  if (!g) ok('persona', 'sin grupos autorizados, se salta');
  else {
    const previa = Q.grupos().find((x) => x.group_id === g.group_id)?.persona || null;
    esperar('persona', ejecutar('grupos', 'persona', { grupoId: g.group_id, persona: 'selftest' }).ok);
    esperar(
      'persona se lee de vuelta',
      Q.grupos().find((x) => x.group_id === g.group_id)?.persona === 'selftest'
    );
    esperar('borrar persona', ejecutar('grupos', 'persona.borrar', { grupoId: g.group_id }).ok);
    if (previa) ejecutar('grupos', 'persona', { grupoId: g.group_id, persona: previa });
    esperar('aprobacion', ejecutar('grupos', 'aprobacion', { grupoId: g.group_id, activo: true }).ok);
    ejecutar('grupos', 'aprobacion', { grupoId: g.group_id, activo: false });
  }
}

// Estas dos solo se pueden probar contra filas que existan en la copia; sin fixtures no
// se inventan. Lo que sí se verifica es que la acción llega a la DB y responde "no
// aplicó" en vez de explotar.
console.log('\n── Sin fixtures (id inexistente ⇒ n=0) ─────────────');
for (const [tab, accion, cuerpo] of [
  ['aprobaciones', 'draft.aprobar', { id: 999999 }],
  ['aprobaciones', 'draft.corregir', { id: 999999, texto: 'x' }],
  ['aprobaciones', 'draft.descartar', { id: 999999 }],
  ['aprobaciones', 'respuesta.aprobar', { id: 999999 }],
  ['aprobaciones', 'respuesta.corregir', { id: 999999, texto: 'x' }],
  ['aprobaciones', 'respuesta.descartar', { id: 999999 }],
  ['outreach', 'cancelar', { id: 999999 }],
  ['tareas', 'descartar', { id: 999999 }],
  ['negocio', 'estado', { id: 999999, estado: 'archived' }],
]) {
  try {
    const r = ejecutar(tab, accion, cuerpo);
    esperar(`${tab}/${accion}`, !r.ok, `n=${r.n}`);
  } catch (err) {
    falla(`${tab}/${accion}`, `explotó: ${err.message}`);
  }
}

// `tareas/hecha` sí avisa y por eso mira la fila antes: con un id inexistente tiene que
// decirlo, no encolar un aviso a nadie.
try {
  ejecutar('tareas', 'hecha', { id: 999999 });
  falla('tareas/hecha', 'aceptó una tarea inexistente');
} catch (err) {
  esperar('tareas/hecha', err instanceof MalaPeticion, err.message.slice(0, 50));
}

console.log(
  fallos
    ? `\n❌ ${fallos} falla(s). La copia quedó modificada: descartala.\n`
    : '\n✅ Capa de escrituras OK. La copia quedó modificada: descartala.\n'
);
process.exit(fallos ? 1 : 0);
