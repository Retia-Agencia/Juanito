// test/setteo.parse.test.js
// Parser PURO del setteo (§18.AZ). Sin red ni DB → corre en Windows.
// El contrato: cubre las formas frecuentes y devuelve 'none' ante la duda; lo que no
// entiende lo intenta setteo-ai.js. Un falso positivo escribe un lead inventado en la
// tabla del closer, así que acá "no entendí" es un resultado CORRECTO.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseSetteoReply, parseFecha, parseResultado, localDateISO, shiftDateISO } =
  await import('../src/setteo/parse.js');

const TZ = 'America/Bogota';
// 3 de agosto de 2026, 22:30 en Bogotá = 4 de agosto 03:30 UTC.
const NOCHE = new Date('2026-08-04T03:30:00Z');
const byNorm = (r, n) => r.items.find((i) => i.leadNorm === n);

// ─── Fecha local (el bug que tenía el prototipo HTML) ─────────────────────────

test('localDateISO usa la fecha LOCAL, no UTC: 22:30 en Bogotá sigue siendo hoy', () => {
  // toISOString() daría '2026-08-04' y todo lo que el closer reporta de noche —justo
  // cuando cierra el día— quedaría con fecha de mañana.
  assert.equal(localDateISO(NOCHE, TZ), '2026-08-03');
  assert.equal(NOCHE.toISOString().slice(0, 10), '2026-08-04'); // deja constancia del bug evitado
});

test('parseFecha: por defecto hoy; "ayer" y "antier" restan días', () => {
  assert.equal(parseFecha('toqué a Juan', { now: NOCHE, tz: TZ }), '2026-08-03');
  assert.equal(parseFecha('ayer toqué a Juan', { now: NOCHE, tz: TZ }), '2026-08-02');
  assert.equal(parseFecha('antier hablé con Ana', { now: NOCHE, tz: TZ }), '2026-08-01');
});

test('parseFecha: acepta DD/MM pasado y IGNORA una fecha futura', () => {
  assert.equal(parseFecha('el 28/07 toqué a Juan', { now: NOCHE, tz: TZ }), '2026-07-28');
  // Futuro = error de tipeo: un setteo se reporta después de hacerlo, no antes.
  assert.equal(parseFecha('el 25/12 toqué a Juan', { now: NOCHE, tz: TZ }), '2026-08-03');
});

test('shiftDateISO cruza fin de mes y año sin corrimiento por TZ', () => {
  assert.equal(shiftDateISO('2026-08-01', -1), '2026-07-31');
  assert.equal(shiftDateISO('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDateISO('2026-02-28', 1), '2026-03-01');
});

// ─── Resultado ────────────────────────────────────────────────────────────────

test('parseResultado: el negativo gana sobre el positivo que contiene', () => {
  // "no contestó" contiene "contestó": sin evaluar el negativo primero, quedaría al revés.
  assert.deepEqual(parseResultado('no contestó'), { contesto: 0, agendo: 0, vendio: 0, matched: true });
  assert.equal(parseResultado('me contestó').contesto, 1);
  assert.equal(parseResultado('me dejó en visto').contesto, 0);
  assert.equal(parseResultado('sin respuesta').contesto, 0);
});

test('parseResultado: "ninguno contestó" es un NO, no un sí', () => {
  assert.equal(parseResultado('ninguno contestó').contesto, 0);
  assert.equal(parseResultado('nadie respondió').contesto, 0);
});

test('parseResultado: agendó y vendió implican contestó', () => {
  assert.deepEqual(parseResultado('agendó'), { contesto: 1, agendo: 1, vendio: 0, matched: true });
  assert.deepEqual(parseResultado('venta cerrada'), { contesto: 1, agendo: 0, vendio: 1, matched: true });
});

test('parseResultado: una señal fuerte gana sobre el "no contestó" inicial', () => {
  const r = parseResultado('no contestaba pero al final agendó');
  assert.equal(r.agendo, 1);
  assert.equal(r.contesto, 1);
});

test('parseResultado: seguimiento cuenta como contestó, sin agenda ni venta', () => {
  const r = parseResultado('quedó en pensarlo, lo dejo en seguimiento');
  assert.deepEqual(r, { contesto: 1, agendo: 0, vendio: 0, matched: true });
});

test('parseResultado: texto sin resultado no marca nada (matched=false)', () => {
  assert.equal(parseResultado('todo bien').matched, false);
});

// ─── Mensajes completos ───────────────────────────────────────────────────────

test('un lead con resultado', () => {
  const r = parseSetteoReply('toqué a Juan Pérez, no contestó', { now: NOCHE, tz: TZ });
  assert.equal(r.kind, 'setteos');
  assert.equal(r.fecha, '2026-08-03');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].leadName, 'Juan Pérez');
  assert.equal(r.items[0].leadNorm, 'juan perez');
  assert.equal(r.items[0].contesto, 0);
});

test('lote de 3 leads en un mensaje, resultado común', () => {
  const r = parseSetteoReply('toqué a Juan, María y Pedro, ninguno contestó', { now: NOCHE, tz: TZ });
  assert.equal(r.items.length, 3);
  assert.deepEqual(r.items.map((i) => i.leadNorm).sort(), ['juan', 'maria', 'pedro']);
  assert.ok(r.items.every((i) => i.contesto === 0), 'ninguno contestó');
});

// El caso que obliga a NO aplicar la cola a toda la lista.
test('lote donde la cola habla de UNA sola: no contamina a los demás', () => {
  const r = parseSetteoReply('toqué a Juan, María agendó', { now: NOCHE, tz: TZ });
  assert.equal(r.items.length, 2);
  assert.equal(byNorm(r, 'maria').agendo, 1);
  assert.equal(byNorm(r, 'juan').agendo, 0, 'Juan no agendó: la cola hablaba de María');
});

test('"hablé con X y me contestó" marca la respuesta', () => {
  const r = parseSetteoReply('hablé con Ana Gómez y me contestó', { now: NOCHE, tz: TZ });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].contesto, 1);
  assert.equal(r.items[0].agendo, 0);
});

test('venta directa por WhatsApp', () => {
  const r = parseSetteoReply('Carlos Ruiz compró, cerré la venta', { now: NOCHE, tz: TZ });
  assert.equal(byNorm(r, 'carlos ruiz').vendio, 1);
  assert.equal(byNorm(r, 'carlos ruiz').contesto, 1);
});

test('forma explícita con pipe, una por línea', () => {
  const r = parseSetteoReply('Ana Ruiz | agendó\nLuis Toro | no contestó', { now: NOCHE, tz: TZ });
  assert.equal(r.items.length, 2);
  assert.equal(byNorm(r, 'ana ruiz').agendo, 1);
  assert.equal(byNorm(r, 'luis toro').contesto, 0);
});

test('el mismo lead nombrado dos veces en un mensaje se funde en un item', () => {
  const r = parseSetteoReply('toqué a Marta Díaz. Marta Díaz agendó', { now: NOCHE, tz: TZ });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].agendo, 1);
});

// El closer nombra completo la primera vez y después abrevia. Sin consolidar, "María" y
// "María Gómez" serían dos filas: el conteo se infla y el embudo queda partido.
test('el nombre abreviado se funde con el completo del mismo mensaje', () => {
  const r = parseSetteoReply('toqué a Juan Pérez y María Gómez, María agendó', { now: NOCHE, tz: TZ });
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items.map((i) => i.leadNorm).sort(), ['juan perez', 'maria gomez']);
  assert.equal(byNorm(r, 'maria gomez').agendo, 1, 'el "agendó" tiene que quedar en el lead completo');
  assert.equal(byNorm(r, 'juan perez').agendo, 0);
});

// Adivinar acá le atribuiría la gestión al lead equivocado.
test('si el nombre corto encaja en DOS largos, no se funde con ninguno', () => {
  const r = parseSetteoReply('toqué a Juan Pérez y Juan Gómez. Juan agendó', { now: NOCHE, tz: TZ });
  const norms = r.items.map((i) => i.leadNorm).sort();
  assert.ok(norms.includes('juan perez') && norms.includes('juan gomez'));
  assert.equal(byNorm(r, 'juan perez').agendo, 0, 'no se le puede adjudicar a uno de los dos');
  assert.equal(byNorm(r, 'juan gomez').agendo, 0);
});

test('agregado sin nombres: se devuelve como agregado, NO inventa filas', () => {
  const r = parseSetteoReply('hoy toqué 20 leads, 3 agendaron', { now: NOCHE, tz: TZ });
  assert.equal(r.kind, 'agregado');
  assert.equal(r.conteo, 20);
  assert.equal(r.agendaron, 3);
});

test('conversación normal del closer NO se interpreta como setteo', () => {
  for (const t of ['hola', 'gracias!', '¿cómo va todo?', 'ya mandé el reporte', 'ok', '👍']) {
    assert.equal(parseSetteoReply(t, { now: NOCHE, tz: TZ }).kind, 'none', `no debería parsear: ${t}`);
  }
});

test('vacío o basura devuelve none', () => {
  assert.equal(parseSetteoReply('', { now: NOCHE, tz: TZ }).kind, 'none');
  assert.equal(parseSetteoReply(null, { now: NOCHE, tz: TZ }).kind, 'none');
  assert.equal(parseSetteoReply('   ', { now: NOCHE, tz: TZ }).kind, 'none');
});

test('los nombres no arrastran palabras del resultado', () => {
  const r = parseSetteoReply('toqué a Juan y no contestó', { now: NOCHE, tz: TZ });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].leadName, 'Juan', 'no debe quedar "Juan Y No"');
});

test('la fecha del mensaje aplica a todos los items', () => {
  const r = parseSetteoReply('ayer toqué a Juan, María y Pedro', { now: NOCHE, tz: TZ });
  assert.equal(r.fecha, '2026-08-02');
  assert.equal(r.items.length, 3);
});
