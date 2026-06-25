// test/approval-intent.test.js
// Detección determinista de aprobaciones en la consola (parseApproval). Puro.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseApproval, parseDiscard, parseApprovalTarget } = await import('../src/common/approval-intent.js');

test('aprobaciones claras → isApprove true', () => {
  for (const t of [
    'Apruebo',
    'apruebo',
    'Aprobado',
    'aprobada',
    'apruébalo',
    'Envíalo así',
    'envialo',
    'mándalo',
    'dale',
    'Perfecto',
    'ok',
    'okay',
    'listo',
    'así está bien',
    'sí',
    'si',
  ]) {
    assert.equal(parseApproval(t).isApprove, true, `debería aprobar: "${t}"`);
  }
});

test('aprobación con id explícito → captura el id', () => {
  assert.deepEqual(parseApproval('apruebo #3'), { isApprove: true, id: 3 });
  assert.deepEqual(parseApproval('Aprobado 12'), { isApprove: true, id: 12 });
  assert.deepEqual(parseApproval('envíalo así #7'), { isApprove: true, id: 7 });
});

test('NO son aprobaciones (correcciones / pedidos / rechazos)', () => {
  for (const t of [
    'Hazlo más breve',
    'más corto',
    'cámbialo',
    'no me mostraste la versión revisada',
    'envíame la versión revisada',
    'dile que llega mañana',
    'no',
    'no lo mandes',
    'descártalo',
    '¿cuál es?',
  ]) {
    assert.equal(parseApproval(t).isApprove, false, `NO debería aprobar: "${t}"`);
  }
});

test('sin id → id null', () => {
  assert.deepEqual(parseApproval('apruebo'), { isApprove: true, id: null });
});

test('descartes claros → isDiscard true', () => {
  for (const t of ['no', 'No', 'descártalo', 'descartala', 'cancela', 'bórralo', 'elimínala', 'no lo mandes', 'no la envíes']) {
    assert.equal(parseDiscard(t).isDiscard, true, `debería descartar: "${t}"`);
  }
});

test('NO son descartes (aprobaciones / correcciones)', () => {
  for (const t of ['apruebo', 'dale', 'hazlo más corto', 'cámbialo', 'no me mostraste la versión']) {
    assert.equal(parseDiscard(t).isDiscard, false, `NO debería descartar: "${t}"`);
  }
});

test('parseApprovalTarget extrae tipo+id de la notificación citada', () => {
  assert.deepEqual(
    parseApprovalTarget('📨 *Respuesta pendiente #5* para el grupo *Patah*'),
    { type: 'reply', id: 5 }
  );
  assert.deepEqual(
    parseApprovalTarget('📝 *Borrador #12* para *Patah* (sale hoy a las 09:00 si lo apruebas):'),
    { type: 'draft', id: 12 }
  );
});

test('parseApprovalTarget → null si no hay notificación reconocible', () => {
  assert.equal(parseApprovalTarget(''), null);
  assert.equal(parseApprovalTarget(null), null);
  assert.equal(parseApprovalTarget('hola, cómo estás'), null);
});
