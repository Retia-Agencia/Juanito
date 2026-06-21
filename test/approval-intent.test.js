// test/approval-intent.test.js
// Detección determinista de aprobaciones en la consola (parseApproval). Puro.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseApproval } = await import('../src/common/approval-intent.js');

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
