// test/commands.test.js
// Cubre handleCommand: /whoami (cualquiera) y /status (solo admin).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { handleCommand } = await import('../src/bot/commands.js');

const deps = {
  listOptins: () => [{ phone: '1' }, { phone: '2' }, { phone: '3' }],
  isConnected: () => true,
};

test('/whoami devuelve ID y rol', () => {
  const out = handleCommand({ text: '/whoami', sender: '129@lid', role: 'admin' });
  assert.match(out, /129@lid/);
  assert.match(out, /admin/);
});

test('/whoami tolera mayúsculas y espacios, y tiene alias /id', () => {
  assert.match(handleCommand({ text: '  /WhoAmI ', sender: 'x@lid', role: 'boss' }), /x@lid/);
  assert.match(handleCommand({ text: '/id', sender: 'y@lid', role: 'boss' }), /y@lid/);
});

test('/status (admin) reporta estado con las deps inyectadas', () => {
  const out = handleCommand({ text: '/status', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /WhatsApp: conectado/);
  assert.match(out, /Opt-ins registrados: 3/);
});

test('/status refleja DRY_RUN OFF cuando la env lo apaga', () => {
  const saved = process.env.CALENDLY_DRY_RUN;
  process.env.CALENDLY_DRY_RUN = 'false';
  try {
    const out = handleCommand({ text: '/status', sender: 'a@lid', role: 'admin' }, deps);
    assert.match(out, /DRY_RUN: OFF/);
  } finally {
    if (saved === undefined) delete process.env.CALENDLY_DRY_RUN;
    else process.env.CALENDLY_DRY_RUN = saved;
  }
});

test('/status NO está disponible para el jefe (devuelve null → sigue a Claude)', () => {
  assert.equal(handleCommand({ text: '/status', sender: 'b@lid', role: 'boss' }, deps), null);
});

test('texto que no es comando devuelve null', () => {
  assert.equal(handleCommand({ text: 'hola juanito', sender: 'b@lid', role: 'boss' }), null);
  assert.equal(handleCommand({ text: '', sender: 'b@lid', role: 'admin' }), null);
});

test('/status tolera que listOptins falle (db no lista)', () => {
  const out = handleCommand(
    { text: '/status', sender: 'a@lid', role: 'admin' },
    {
      listOptins: () => {
        throw new Error('db no lista');
      },
      isConnected: () => false,
    }
  );
  assert.match(out, /Opt-ins registrados: 0/);
  assert.match(out, /WhatsApp: desconectado/);
});
