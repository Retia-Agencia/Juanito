// test/setteo.capture.test.js
// Partes puras de la captura (§18.AZ, src/setteo/format.js): el scope del piloto y los
// mensajes que ve el closer. Sin red ni DB → corren en Windows.
// La orquestación (capture.js: DB + HubSpot + WhatsApp) se verifica en el smoke en vivo;
// acá se cubre lo que se puede romper en silencio: que el scope no se abra solo y que la
// confirmación nunca le afirme al closer más de lo que quedó guardado.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { isCloserInScope, buildConfirmacion, buildPedirNombres } = await import('../src/setteo/format.js');

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const CLEAN = { SETTEO_CAPTURE_CLOSERS: undefined, SETTEO_REPORT_CLOSERS: undefined, CALENDLY_PUSH4_CLOSERS: undefined };

// Sin scope configurado NO se captura nada: el default seguro es "nadie", no "todos".
test('scope: sin ninguna var configurada, nadie está en scope', () => {
  withEnv(CLEAN, () => {
    assert.equal(isCloserInScope('sebastian@30x.com'), false);
  });
});

test('scope: solo los emails listados entran', () => {
  withEnv({ ...CLEAN, SETTEO_CAPTURE_CLOSERS: 'sebastian@30x.com, pablo.lozano@30x.com' }, () => {
    assert.equal(isCloserInScope('sebastian@30x.com'), true);
    assert.equal(isCloserInScope('SEBASTIAN@30X.COM'), true, 'no debe depender de mayúsculas');
    assert.equal(isCloserInScope('pablo.lozano@30x.com'), true);
    assert.equal(isCloserInScope('daniela.camacho@30x.com'), false);
    assert.equal(isCloserInScope(null), false);
  });
});

test('scope: cae al del reporte y luego al del nudge, en ese orden', () => {
  withEnv({ ...CLEAN, SETTEO_REPORT_CLOSERS: 'pablo.lozano@30x.com' }, () => {
    assert.equal(isCloserInScope('pablo.lozano@30x.com'), true);
  });
  withEnv({ ...CLEAN, CALENDLY_PUSH4_CLOSERS: 'lucas.mendoza@30x.com' }, () => {
    assert.equal(isCloserInScope('lucas.mendoza@30x.com'), true);
  });
  // El más específico gana sobre el fallback.
  withEnv({ ...CLEAN, SETTEO_CAPTURE_CLOSERS: 'sebastian@30x.com', CALENDLY_PUSH4_CLOSERS: 'lucas.mendoza@30x.com' }, () => {
    assert.equal(isCloserInScope('sebastian@30x.com'), true);
    assert.equal(isCloserInScope('lucas.mendoza@30x.com'), false);
  });
});

// ─── Confirmación ─────────────────────────────────────────────────────────────

const HOY = '2026-08-03';
const item = (over = {}) => ({ leadName: 'Juan Pérez', leadNorm: 'juan perez', contesto: 0, agendo: 0, vendio: 0, ...over });
const res = (over = {}) => ({ guardados: 1, calls: 0, ambiguos: 0, sinMatch: 0, nombres: ['Juan Pérez'], ...over });

test('confirmación simple: cuántos quedaron', () => {
  const msg = buildConfirmacion({ fecha: HOY, items: [item()], resultado: res(), hoy: HOY });
  assert.match(msg, /\*1\* setteo\b/);
  assert.match(msg, /missetteos/);
});

test('confirmación: el desglose del embudo aparece cuando hay algo que contar', () => {
  const items = [item({ contesto: 1, agendo: 1 }), item({ leadNorm: 'b', contesto: 1 }), item({ leadNorm: 'c' })];
  const msg = buildConfirmacion({ fecha: HOY, items, resultado: res({ guardados: 3 }), hoy: HOY });
  assert.match(msg, /\*3\* setteos/);
  assert.match(msg, /2 contestaron/);
  assert.match(msg, /1 agendó/);
});

test('confirmación: sin resultados no inventa un desglose vacío', () => {
  const msg = buildConfirmacion({ fecha: HOY, items: [item()], resultado: res(), hoy: HOY });
  assert.doesNotMatch(msg, /contestaron|agendaron|venta/);
});

// Contarlo como setteo Y como call inflaría el número del propio closer.
test('confirmación: avisa cuáles ya eran leads de call', () => {
  const msg = buildConfirmacion({ fecha: HOY, items: [item()], resultado: res({ calls: 1 }), hoy: HOY });
  assert.match(msg, /cita agendada/);
  assert.match(msg, /call, no como setteo/);
});

// Nunca descartar en silencio: el closer tiene que poder ver qué no se cruzó.
test('confirmación: avisa homónimos y leads que no están en HubSpot', () => {
  const msg = buildConfirmacion({ fecha: HOY, items: [item()], resultado: res({ ambiguos: 2, sinMatch: 3 }), hoy: HOY });
  assert.match(msg, /2 con homónimos/);
  assert.match(msg, /3 que no encontré en HubSpot/);
});

test('confirmación: si la fecha no es hoy, lo dice (evita anotar al día equivocado sin avisar)', () => {
  const ayer = buildConfirmacion({ fecha: '2026-08-02', items: [item()], resultado: res(), hoy: HOY });
  assert.match(ayer, /del 2026-08-02/);
  const hoy = buildConfirmacion({ fecha: HOY, items: [item()], resultado: res(), hoy: HOY });
  assert.doesNotMatch(hoy, /del 2026-08-03/);
});

// Inventar filas para cuadrar el número sería escribir datos falsos en la tabla que
// alimenta una conversación sobre comisiones.
test('sin nombres se piden los nombres, con un ejemplo de cómo mandarlos', () => {
  const msg = buildPedirNombres(20);
  assert.match(msg, /\*20\*/);
  assert.match(msg, /nombres/);
  assert.match(msg, /toqué a Juan Pérez/);
});
