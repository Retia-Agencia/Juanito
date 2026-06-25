// test/vcard.test.js
// Tarjetas de contacto compartidas (Fase 3B). parseVcard / extractSharedContacts /
// describeSharedContacts son PURAS (sin Baileys) → corren nativo en Windows.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseVcard, extractSharedContacts, describeSharedContacts } = await import('../src/common/utils.js');

const VCARD_WAID = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'N:;Juan Pérez;;;',
  'FN:Juan Pérez',
  'TEL;type=CELL;type=VOICE;waid=573001234567:+57 300 1234567',
  'END:VCARD',
].join('\n');

const VCARD_NO_WAID = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:María Gómez',
  'TEL;type=CELL:+57 (320) 765-4321',
  'END:VCARD',
].join('\n');

test('parseVcard prefiere el waid (número canónico de WhatsApp)', () => {
  assert.deepEqual(parseVcard(VCARD_WAID), { name: 'Juan Pérez', phones: ['573001234567'] });
});

test('parseVcard sin waid → normaliza el TEL a solo dígitos', () => {
  assert.deepEqual(parseVcard(VCARD_NO_WAID), { name: 'María Gómez', phones: ['573207654321'] });
});

test('parseVcard vacío/inválido → name null, phones []', () => {
  assert.deepEqual(parseVcard(''), { name: null, phones: [] });
  assert.deepEqual(parseVcard(null), { name: null, phones: [] });
});

test('extractSharedContacts: contactMessage único (displayName gana al FN)', () => {
  const message = { contactMessage: { displayName: 'Juanito Lead', vcard: VCARD_WAID } };
  assert.deepEqual(extractSharedContacts(message), [
    { name: 'Juanito Lead', phone: '573001234567', phones: ['573001234567'] },
  ]);
});

test('extractSharedContacts: contactsArrayMessage (varios)', () => {
  const message = {
    contactsArrayMessage: {
      contacts: [
        { displayName: 'Juan', vcard: VCARD_WAID },
        { displayName: 'María', vcard: VCARD_NO_WAID },
      ],
    },
  };
  const out = extractSharedContacts(message);
  assert.equal(out.length, 2);
  assert.equal(out[0].phone, '573001234567');
  assert.equal(out[1].phone, '573207654321');
});

test('extractSharedContacts: mensaje sin contactos → []', () => {
  assert.deepEqual(extractSharedContacts({ conversation: 'hola' }), []);
  assert.deepEqual(extractSharedContacts(null), []);
});

test('describeSharedContacts marca el número como confiable y legible', () => {
  const txt = describeSharedContacts([{ name: 'Juan', phone: '573001234567', phones: ['573001234567'] }]);
  assert.match(txt, /tarjeta de contacto/i);
  assert.match(txt, /CONFIABLES/);
  assert.match(txt, /\+573001234567/);
});

test('describeSharedContacts: sin contactos → null', () => {
  assert.equal(describeSharedContacts([]), null);
  assert.equal(describeSharedContacts(null), null);
});
