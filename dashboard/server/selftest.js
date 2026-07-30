// dashboard/server/selftest.js
// Ejercita TODA la capa de lectura contra una DB real y reporta. Existe porque
// better-sqlite3 no compila en cualquier Node de escritorio: la verificación de
// verdad es dentro del contenedor.
//
// Uso (sobre una COPIA, nunca sobre la base viva). Va en `juanito-dash`, NO en
// `juanito-agent`: el Dockerfile no mete `dashboard/` en la imagen y el bot tampoco la
// bind-montea, así que /app/dashboard existe solo en el contenedor del dashboard.
//   docker exec juanito-dash node -e "const D=require('better-sqlite3');\
//     new D('/app/data/brain.sqlite',{readonly:true}).exec(\"VACUUM INTO '/tmp/copia.sqlite'\")"
//   docker exec -e DB_PATH=/tmp/copia.sqlite juanito-dash node /app/dashboard/server/selftest.js

import * as Q from './queries.js';
import * as watchdog from './watchdog.js';

const resumen = (v) => {
  if (Array.isArray(v)) return `${v.length} fila(s)`;
  if (v && typeof v === 'object') {
    return Object.entries(v)
      .map(([k, x]) => `${k}=${Array.isArray(x) ? x.length : typeof x === 'object' && x ? '{}' : x}`)
      .join(' ');
  }
  return String(v);
};

let fallos = 0;

function probar(nombre, fn) {
  try {
    const t0 = Date.now();
    const r = fn();
    console.log(`  ok  ${nombre.padEnd(16)} ${String(Date.now() - t0).padStart(4)}ms  ${resumen(r)}`);
    return r;
  } catch (err) {
    fallos++;
    console.log(`  FALLA ${nombre.padEnd(14)} ${err.message}`);
    return null;
  }
}

console.log('\n── Salud ────────────────────────────────────────────');
const s = probar('salud', () => Q.salud());
if (s) {
  console.log(`\n  nivel global: ${s.nivel.toUpperCase()}\n`);
  for (const c of s.checks) {
    const icono = { ok: '  ', warn: '🟡', error: '🔴' }[c.level];
    console.log(`  ${icono} ${c.label.padEnd(38)} ${String(c.count).padStart(4)}  ${c.detail}`);
  }
}

console.log('\n── Listados ─────────────────────────────────────────');
probar('aprobaciones', () => Q.aprobaciones());
probar('grupos', () => Q.grupos());
probar('programados', () => Q.programados());
probar('outreach', () => Q.outreach());
probar('tareas', () => Q.tareas());
probar('negocio', () => Q.negocio());
probar('recordatorios', () => Q.recordatorios());
probar('calls', () => Q.calls());
probar('optins', () => Q.optins());

console.log('\n── Registries (desde código) ────────────────────────');
const r = probar('registries', () => Q.registries());
if (r) {
  console.log(
    `     programas=${r.programas.length} conexiones=${r.conexiones.length} ` +
      `closers=${r.closers.length} ignorados=${r.ignorados.length}`
  );
  // Invariante de seguridad: los tokens NUNCA se serializan. `tieneToken` puede ser booleano o
  // `null` (2026-07-30: el dashboard corre en otro contenedor y no recibe las env de Calendly,
  // así que dejó de adivinar el valor — ver el comentario de `conexiones` en queries.js). Lo que
  // NO puede ser nunca es un string: eso sería el token viajando en el JSON.
  const json = JSON.stringify(r);
  const filtrado = !/"token"/.test(json) && r.conexiones.every((c) => typeof c.tieneToken !== 'string');
  console.log(`     tokens fuera del JSON: ${filtrado ? 'sí ✅' : 'NO ❌'}`);
  if (!filtrado) fallos++;
}

console.log('\n── Watchdog (escribe en la COPIA) ───────────────────');
probar('initSchema', () => watchdog.initSchema());
const ev = probar('evaluar', () => watchdog.evaluar());
if (ev) console.log(`     alertó=${ev.alertó} nivel=${ev.nivel} problemas=${ev.problemas.length}`);
probar('dedup', () => {
  const segundo = watchdog.evaluar();
  if (ev?.alertó && segundo.alertó) throw new Error('el dedup no frenó la segunda alerta');
  return `segunda corrida alertó=${segundo.alertó} (dedup ${segundo.dedup ? 'activo' : 'n/a'})`;
});
probar('historial', () => watchdog.historial());

console.log(`\n${fallos === 0 ? '✅ selftest OK' : `❌ ${fallos} fallo(s)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
