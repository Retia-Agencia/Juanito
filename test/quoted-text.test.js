// test/quoted-text.test.js
// extractQuotedText: lee el texto del mensaje citado (reply nativo de WhatsApp) desde el
// contextInfo de Baileys. Puro (recibe msg.message), corre nativo en Windows.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { extractQuotedText } = await import('../src/common/utils.js');

test('reply de texto sobre texto simple (conversation)', () => {
  const message = {
    extendedTextMessage: {
      text: 'apruebo',
      contextInfo: {
        stanzaId: 'ABC',
        quotedMessage: { conversation: '📨 *Respuesta pendiente #3* para el grupo X' },
      },
    },
  };
  assert.equal(extractQuotedText(message), '📨 *Respuesta pendiente #3* para el grupo X');
});

test('reply sobre un mensaje con formato (extendedTextMessage.text)', () => {
  const message = {
    extendedTextMessage: {
      text: 'no',
      contextInfo: {
        quotedMessage: { extendedTextMessage: { text: '📝 *Borrador #9* para Patah' } },
      },
    },
  };
  assert.equal(extractQuotedText(message), '📝 *Borrador #9* para Patah');
});

test('reply sobre el caption de una imagen', () => {
  const message = {
    extendedTextMessage: {
      text: 'sí',
      contextInfo: { quotedMessage: { imageMessage: { caption: 'mira esto' } } },
    },
  };
  assert.equal(extractQuotedText(message), 'mira esto');
});

test('contextInfo dentro de un media entrante (reply hecho con imagen)', () => {
  const message = {
    imageMessage: {
      caption: 'apruebo',
      contextInfo: { quotedMessage: { conversation: 'Borrador #2' } },
    },
  };
  assert.equal(extractQuotedText(message), 'Borrador #2');
});

test('mensaje normal SIN reply → null', () => {
  assert.equal(extractQuotedText({ conversation: 'hola' }), null);
  assert.equal(extractQuotedText({ extendedTextMessage: { text: 'hola' } }), null);
});

test('entradas inválidas → null sin romper', () => {
  assert.equal(extractQuotedText(null), null);
  assert.equal(extractQuotedText(undefined), null);
  assert.equal(extractQuotedText('texto'), null);
  assert.equal(extractQuotedText({}), null);
});
