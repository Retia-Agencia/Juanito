// test/setteo.correccion.test.js
// El guard de intención y el endurecimiento del parser (§18.BE). Puro: corre en Windows.
//
// Los tres casos salieron del smoke del 2026-08-04, en el mismo minuto:
//   "Elimina contestk"                    → ✅ Anotado: 1 setteo   (creó un lead "Elimina")
//   "Descarta a contestk y Fernanda Joya" → ✅ Anotado: 2 setteos
//   "toqué a Andrea Gomez, contestk"      → guardó "Andrea Gomez" Y "contestk"
// O sea: el closer pidió BORRAR y se le CREÓ. Tres veces.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { esCorreccion, parseSetteoReply } = await import('../src/setteo/parse.js');

// ─── Guard de intención ───────────────────────────────────────────────────────

test('reconoce las formas reales en que un closer pide borrar', () => {
  for (const t of [
    'Descarta a Elimina',
    'Descarta a contestk y Fernanda Joya',
    'Elimina contestk',
    'borra el de Juan',
    'borrá el de Juan',
    'quita a María de hoy',
    'anula lo de ayer',
    'corrige el de Pedro, no agendó',
    'me equivoqué con Ana',
    'no era Juan, era Julián',
    'olvidá lo que dije',
    'mentiras, descarta eso',
  ]) {
    assert.equal(esCorreccion(t), true, `debía verse como corrección: "${t}"`);
  }
});

test('un reporte normal NO se confunde con una corrección', () => {
  // El falso positivo cuesta poco (el mensaje cae en el contexto agéntico, que igual sabe
  // registrar), pero el guard tampoco puede tragarse todo: si se lleva los reportes, la
  // captura determinista deja de existir.
  for (const t of [
    'Hoy toqué a Juan Pérez y María Gómez, María agendó',
    'hablé con maria lopez pero no me contestó',
    'toqué 20 leads, 5 contestaron',
    'Ana Ruiz | agendó',
    'Massimo Soriano contestó y agendó',
  ]) {
    assert.equal(esCorreccion(t), false, `NO debía verse como corrección: "${t}"`);
  }
});

test('el guard tolera acentos y mayúsculas', () => {
  assert.equal(esCorreccion('DESCARTÁ ESO'), true);
  assert.equal(esCorreccion('Anulá el último'), true);
  assert.equal(esCorreccion(''), false);
  assert.equal(esCorreccion(null), false);
});

// ─── Parser: un verbo mal escrito no es un lead ───────────────────────────────

test('un resultado mal tipeado no se guarda como lead', () => {
  // El caso exacto del smoke: "contestk" quedó como fila con nombre propio.
  const r = parseSetteoReply('Toque a Andrea Gomez, contestk');
  assert.equal(r.kind, 'setteos');
  const nombres = r.items.map((i) => i.leadName.toLowerCase());
  assert.ok(nombres.includes('andrea gomez'), 'Andrea sí es un lead');
  assert.ok(!nombres.some((n) => n.startsWith('contest')), `"contestk" no puede ser un lead: ${nombres.join(', ')}`);
});

test('un verbo de corrección con mayúscula no se lee como nombre propio', () => {
  // "Elimina contestk": la regla 3 buscaba "Nombre + resultado" y encontraba las dos cosas
  // donde no había ninguna. Ahora ni siquiera llega acá (lo para el guard), pero el parser
  // tampoco debe morder si lo llaman directo.
  const r = parseSetteoReply('Elimina contestk');
  assert.notEqual(r.kind, 'setteos', `no debía parsear nada: ${JSON.stringify(r.items || [])}`);
});

test('los nombres legítimos siguen entrando (sin regresión)', () => {
  // La red de seguridad del endurecimiento: apretar el parser no puede costar leads reales.
  const r = parseSetteoReply('Hoy toqué a Juan Pérez y María Gómez, María agendó');
  assert.equal(r.kind, 'setteos');
  const nombres = r.items.map((i) => i.leadName);
  assert.ok(nombres.some((n) => /Juan/.test(n)), `falta Juan: ${nombres.join(', ')}`);
  assert.ok(nombres.some((n) => /Mar/.test(n)), `falta María: ${nombres.join(', ')}`);
  assert.equal(r.items.length, 2, 'exactamente dos leads');
});
