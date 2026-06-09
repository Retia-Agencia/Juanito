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

test('/status para el jefe → deflexión cálida (no diagnósticos técnicos)', () => {
  // El jefe está sandboxed: en vez de null/silencio, recibe un mensaje amable.
  const out = handleCommand({ text: '/status', sender: 'b@lid', role: 'boss' }, deps);
  assert.match(out, /equipo técnico/);
});

test('texto que no es comando devuelve null', () => {
  assert.equal(handleCommand({ text: 'hola juanito', sender: 'b@lid', role: 'boss' }), null);
  assert.equal(handleCommand({ text: '', sender: 'b@lid', role: 'admin' }), null);
});

// ─── /calendly (botón de pánico, admin-only) ──────────────────────────────────

function calendlyDeps() {
  const state = { global: false, closers: {} };
  return {
    _state: state,
    isCalendlyPaused: () => state.global,
    setCalendlyPaused: (v) => { state.global = !!v; },
    setCloserPaused: (phone, v) => { state.closers[phone] = !!v; return phone === '+573046131437' ? 1 : 0; },
    listOptins: () => [
      { phone: '+573046131437', name: 'Pablo Lozano', paused: state.closers['+573046131437'] ? 1 : 0 },
    ],
    resolveCloserByPushName: (n) =>
      /pablo lozano/i.test(n) ? { email: 'pablo.lozano@30x.com', name: 'Pablo Lozano', phone: '+573046131437' } : null,
  };
}

test('/calendly para no-admin → deflexión (no expone estado)', () => {
  assert.match(handleCommand({ text: '/calendly', sender: 'b@lid', role: 'boss' }, calendlyDeps()), /equipo técnico/);
  assert.match(handleCommand({ text: '/calendly off', sender: 'u@lid', role: 'unknown' }, calendlyDeps()), /equipo técnico/);
});

test('/calendly (admin) sin args → muestra estado global y closers pausados', () => {
  const out = handleCommand({ text: '/calendly', sender: 'a@lid', role: 'admin' }, calendlyDeps());
  assert.match(out, /Estado global: activo/);
  assert.match(out, /Closers pausados: ninguno/);
});

test('/calendly off | on (global) pausa y reactiva, y se refleja en el estado', () => {
  const deps = calendlyDeps();
  assert.match(handleCommand({ text: '/calendly off', sender: 'a@lid', role: 'admin' }, deps), /PAUSADOS ⏸️ \(global\)/);
  assert.equal(deps._state.global, true);
  assert.match(handleCommand({ text: '/calendly', sender: 'a@lid', role: 'admin' }, deps), /Estado global: PAUSADO/);
  assert.match(handleCommand({ text: '/calendly on', sender: 'a@lid', role: 'admin' }, deps), /reactivados ▶️ \(global\)/);
  assert.equal(deps._state.global, false);
});

test('/calendly off <closer> pausa solo a ese closer (nombre completo)', () => {
  const deps = calendlyDeps();
  const out = handleCommand({ text: '/calendly off Pablo Lozano', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /Pablo Lozano: PAUSADOS ⏸️/);
  assert.equal(deps._state.closers['+573046131437'], true);
});

test('/calendly off con closer desconocido → mensaje de ayuda, no pausa nada', () => {
  const deps = calendlyDeps();
  const out = handleCommand({ text: '/calendly off Fulano', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /No reconozco al closer/);
  assert.equal(deps._state.global, false);
});

test('/calendly con acción inválida → uso', () => {
  assert.match(
    handleCommand({ text: '/calendly foo', sender: 'a@lid', role: 'admin' }, calendlyDeps()),
    /Uso: \/calendly/
  );
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
