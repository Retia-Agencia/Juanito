// test/calendly.confirmacion-logic.test.js
// Tests PUROS de la confirmación del Push 2 (§18.CN). Sin DB/WA → Windows.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseConfirmacion,
  resolverConfirmacion,
  esCorreccionClara,
  buildConfirmacionPregunta,
  buildConfirmacionResumen,
  ordenarPorHora,
} = await import('../src/calendly/confirmacion-logic.js');

const final = (texto, n = 3, primera = true) => {
  const p = parseConfirmacion(texto, n);
  return p.kind === 'ok' ? resolverConfirmacion(p, n, { primera }) : p;
};

test('números solos: confirmaron esos, el resto no', () => {
  assert.deepEqual(final('1 3'), { 1: 'confirmada', 2: 'no_confirmada', 3: 'confirmada' });
  assert.deepEqual(final('1, 3'), { 1: 'confirmada', 2: 'no_confirmada', 3: 'confirmada' });
});

test('todos / ninguno', () => {
  assert.deepEqual(final('todos'), { 1: 'confirmada', 2: 'confirmada', 3: 'confirmada' });
  assert.deepEqual(final('Sí, todas ✅'), { 1: 'confirmada', 2: 'confirmada', 3: 'confirmada' });
  assert.deepEqual(final('ninguno todavía'), { 1: 'no_confirmada', 2: 'no_confirmada', 3: 'no_confirmada' });
  assert.deepEqual(final('no todos'), { 1: 'no_confirmada', 2: 'no_confirmada', 3: 'no_confirmada' });
});

test('"todas las llamadas" no es un "todas": no pisa al "ninguno" (caso real 14-oct)', () => {
  const NO = { 1: 'no_confirmada', 2: 'no_confirmada', 3: 'no_confirmada' };
  assert.deepEqual(final('Ninguno, mándame el primer push de todas las llamadas de hoy'), NO);
  assert.deepEqual(final('ninguno de todos mis leads'), NO);
  // Las dos respuestas, opuestas, en el mismo mensaje: se repregunta en vez de adivinar.
  assert.deepEqual(parseConfirmacion('ninguno... ah espera, todos', 3), { kind: 'unknown' });
  // Sin una respuesta real, un "todas las …" suelto no se entiende como "todas".
  assert.deepEqual(parseConfirmacion('mándame todas las llamadas de hoy', 3), { kind: 'unknown' });
});

test('todos menos uno', () => {
  assert.deepEqual(final('todos menos el 2'), { 1: 'confirmada', 2: 'no_confirmada', 3: 'confirmada' });
  assert.deepEqual(final('todos menos el 2 que canceló'), { 1: 'confirmada', 2: 'cancelada', 3: 'confirmada' });
});

test('mezcla de estados con palabras', () => {
  assert.deepEqual(final('2 canceló, 1 y 3 confirmaron'), { 1: 'confirmada', 2: 'cancelada', 3: 'confirmada' });
  assert.deepEqual(final('1 si 2 no 3 cancelo'), { 1: 'confirmada', 2: 'no_confirmada', 3: 'cancelada' });
  assert.deepEqual(final('el 1 confirmó, el 3 no ha respondido'), { 1: 'confirmada', 2: 'no_confirmada', 3: 'no_confirmada' });
  assert.deepEqual(final('1 ✅ 2 ❌'), { 1: 'confirmada', 2: 'no_confirmada', 3: 'no_confirmada' });
});

test('"no confirmó" no se vuelve confirmada', () => {
  assert.deepEqual(final('el 2 no confirmó', 2), { 1: 'no_confirmada', 2: 'no_confirmada' });
});

test('"no va" / "no puede" es cancelada', () => {
  assert.deepEqual(final('el 2 no va', 2), { 1: 'no_confirmada', 2: 'cancelada' });
  assert.deepEqual(final('1 confirmó, 2 no puede', 2), { 1: 'confirmada', 2: 'cancelada' });
});

test('números fuera de rango se ignoran; sin nada útil no se entiende', () => {
  assert.deepEqual(final('1 7', 3), { 1: 'confirmada', 2: 'no_confirmada', 3: 'no_confirmada' });
  assert.deepEqual(parseConfirmacion('ok gracias', 3), { kind: 'unknown' });
  assert.deepEqual(parseConfirmacion('9', 3), { kind: 'unknown' });
});

test('corrección tardía: solo cambia lo que nombra', () => {
  assert.deepEqual(final('el 2 canceló', 3, false), { 2: 'cancelada' });
  assert.equal(esCorreccionClara(parseConfirmacion('el 2 canceló', 3)), true);
  assert.equal(esCorreccionClara(parseConfirmacion('todos', 3)), false);
  assert.equal(esCorreccionClara(parseConfirmacion('hola', 3)), false);
});

test('la pregunta numera por hora y el resumen repite el estado', () => {
  const items = ordenarPorHora([
    { name: 'Laura Ríos', startIso: '2026-10-14T20:00:00Z' },
    { name: 'Ana Pérez', startIso: '2026-10-14T14:00:00Z' },
  ]);
  const msg = buildConfirmacionPregunta({ items, tz: 'America/Bogota' });
  assert.match(msg, /1\. 0?9:00.*Ana Pérez/);
  assert.match(msg, /2\. 0?3:00.*Laura Ríos/);
  const res = buildConfirmacionResumen({ items, estados: { 1: 'confirmada', 2: 'cancelada' } });
  assert.match(res, /Ana Pérez: ✅ confirmó/);
  assert.match(res, /Laura Ríos: ❌ canceló/);
});
