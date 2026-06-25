// test/documents.test.js
// Generación de documentos (Fase 3A). buildDocument/render* son independientes de la DB y
// de Baileys → corren nativo en Windows (requieren pdfkit y docx instalados).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildDocument, safeFileName, renderTxt } = await import('../src/documents/index.js');

test('safeFileName: sin acentos ni caracteres raros, con extensión', () => {
  assert.equal(safeFileName('Propuesta — Cliente Ñoño!', 'pdf'), 'Propuesta-Cliente-Nono.pdf');
  assert.equal(safeFileName('', 'txt'), 'documento.txt');
});

test('renderTxt incluye título subrayado + contenido', () => {
  const buf = renderTxt('Hola', 'cuerpo del doc');
  const s = buf.toString('utf8');
  assert.match(s, /^Hola\n=+\n\ncuerpo del doc/);
});

test('buildDocument txt → buffer de texto + mimetype + nombre', async () => {
  const d = await buildDocument({ title: 'Notas', content: 'línea uno\n\nlínea dos', format: 'txt' });
  assert.equal(d.mimetype, 'text/plain');
  assert.equal(d.fileName, 'Notas.txt');
  assert.match(d.buffer.toString('utf8'), /línea uno/);
});

test('buildDocument pdf → buffer con cabecera %PDF', async () => {
  const d = await buildDocument({ title: 'Propuesta', content: 'Hola mundo', format: 'pdf' });
  assert.equal(d.mimetype, 'application/pdf');
  assert.equal(d.fileName, 'Propuesta.pdf');
  assert.ok(d.buffer.length > 100);
  assert.equal(d.buffer.subarray(0, 4).toString('latin1'), '%PDF');
});

test('buildDocument docx → buffer ZIP (PK) con mimetype Word', async () => {
  const d = await buildDocument({ title: 'Carta', content: 'Estimado cliente', format: 'docx' });
  assert.match(d.mimetype, /wordprocessingml\.document$/);
  assert.equal(d.fileName, 'Carta.docx');
  assert.equal(d.buffer.subarray(0, 2).toString('latin1'), 'PK');
});

test('buildDocument: formato desconocido → cae a pdf', async () => {
  const d = await buildDocument({ title: 'X', content: 'y', format: 'rtf' });
  assert.equal(d.mimetype, 'application/pdf');
});

test('buildDocument sin contenido → lanza', async () => {
  await assert.rejects(() => buildDocument({ title: 'X', content: '   ', format: 'pdf' }), /contenido/);
});
