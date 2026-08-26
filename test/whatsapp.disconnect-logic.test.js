// test/whatsapp.disconnect-logic.test.js
// La decisión más cara del sistema: qué hacer cuando WhatsApp cierra el socket.
//
// Un error acá no se ve como un bug, se ve como el número del bot inutilizable por días. Por eso
// la lógica vive en un módulo puro y por eso estos tests son explícitos hasta ser repetitivos:
// cada rama que puede terminar en un reintento rápido está fijada por su propio caso.
//
// El invariante que más importa está en el último bloque: NADA puede elegir 'reopen' antes de
// haber conectado. Esa es la rama del softban del 2026-07-28.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideOnClose, CIERRE, MAX_REOPENS, ESPERAS_MS, SANO_MS } from '../src/whatsapp/disconnect-logic.js';

// Caso base: sesión vinculada, ya conectada, flag PRENDIDO. Los tests que prueban el flag
// apagado o el pairing lo sobrescriben.
const caso = (extra = {}) => ({
  statusCode: CIERRE.connectionClosed,
  hasConnected: true,
  hasCreds: true,
  reopens: 0,
  hotReopen: true,
  ...extra,
});

// ─── El flag apagado no cambia NADA del comportamiento de hoy ─────────────────

test('con el flag apagado, cualquier cierre tras conectar sale con exit(1) — el comportamiento actual', () => {
  for (const code of Object.values(CIERRE)) {
    if (code === CIERRE.loggedOut || code === CIERRE.restartRequired) continue; // tienen su rama propia
    const d = decideOnClose(caso({ statusCode: code, hotReopen: false }));
    assert.equal(d.action, 'exit', `${code} debería salir con el flag apagado`);
    assert.equal(d.code, 1);
  }
});

// ─── Las ramas que NO dependen del flag ───────────────────────────────────────

test('loggedOut sale con code 2 (salida limpia): no hay nada que reintentar sin un humano', () => {
  for (const hotReopen of [true, false]) {
    const d = decideOnClose(caso({ statusCode: CIERRE.loggedOut, hotReopen }));
    assert.equal(d.action, 'exit');
    assert.equal(d.code, 2, 'code 2 = entrypoint.sh NO reintenta');
  }
});

test('restartRequired (515) reabre en caliente y NO gasta presupuesto: es parte del handshake', () => {
  // Incluso con el presupuesto agotado, porque no es una caída.
  const d = decideOnClose(caso({ statusCode: CIERRE.restartRequired, reopens: MAX_REOPENS, hotReopen: false }));
  assert.equal(d.action, 'reopen');
  assert.equal(d.waitMs, 1000);
});

// ─── La allowlist ─────────────────────────────────────────────────────────────

test('428 y 408 son cable cortado → reabren', () => {
  for (const code of [CIERRE.connectionClosed, CIERRE.timedOut]) {
    assert.equal(decideOnClose(caso({ statusCode: code })).action, 'reopen', `${code} debería reabrir`);
  }
});

test('440 connectionReplaced SALE: reabrir es pelearse por la sesión en loop', () => {
  const d = decideOnClose(caso({ statusCode: CIERRE.connectionReplaced }));
  assert.equal(d.action, 'exit');
  assert.equal(d.code, 1);
});

test('403 · 411 · 500 · 503 salen: el problema no es el cable, reabrir lo reproduce', () => {
  for (const code of [CIERRE.forbidden, CIERRE.multideviceMismatch, CIERRE.badSession, CIERRE.unavailableService]) {
    assert.equal(decideOnClose(caso({ statusCode: code })).action, 'exit', `${code} debería salir`);
  }
});

test('un código DESCONOCIDO sale: la allowlist tiene que fallar del lado que no nos banea', () => {
  for (const code of [405, 499, 9999, undefined, null]) {
    assert.equal(decideOnClose(caso({ statusCode: code })).action, 'exit', `${code} debería salir`);
  }
});

// ─── El presupuesto ───────────────────────────────────────────────────────────

test('las esperas crecen y NUNCA son 0: un reopen inmediato es el patrón que dispara la detección', () => {
  const esperas = [0, 1, 2].map((reopens) => decideOnClose(caso({ reopens })).waitMs);
  assert.deepEqual(esperas, ESPERAS_MS);
  for (const w of esperas) assert.ok(w > 0, 'ninguna espera puede ser inmediata');
});

test('agotado el presupuesto sale, para que entrypoint.sh aplique su backoff largo', () => {
  const d = decideOnClose(caso({ reopens: MAX_REOPENS }));
  assert.equal(d.action, 'exit');
  assert.equal(d.code, 1);
  assert.match(d.reason, /reaperturas gastadas/);
});

test('el presupuesto no se puede pasar por encima con un número raro', () => {
  assert.equal(decideOnClose(caso({ reopens: 99 })).action, 'exit');
});

// ─── El reset por conexión sana ───────────────────────────────────────────────
// Sin esto, cuatro caídas repartidas en un día agotarían las reaperturas igual que el ATTEMPT
// de entrypoint.sh acumulaba hacia el borde. Es el mismo bug un nivel más arriba.

test('una conexión que duró lo suficiente reinicia el presupuesto', () => {
  const d = decideOnClose(caso({ reopens: MAX_REOPENS, uptimeMs: SANO_MS }));
  assert.equal(d.action, 'reopen', 'con el presupuesto agotado pero una conexión sana, se reabre');
  assert.equal(d.waitMs, ESPERAS_MS[0], 'y la espera vuelve a la primera de la escalera');
  assert.equal(d.resetReopens, true, 'el caller tiene que poner su contador en 0');
});

test('una conexión CORTA no reinicia nada: eso sí es una racha', () => {
  const d = decideOnClose(caso({ reopens: 2, uptimeMs: SANO_MS - 1 }));
  assert.equal(d.action, 'reopen');
  assert.equal(d.waitMs, ESPERAS_MS[2], 'sigue escalando donde iba');
  assert.ok(!d.resetReopens);
});

test('el umbral de sano es el MISMO que el de entrypoint.sh (10 min), a propósito', () => {
  assert.equal(SANO_MS, 10 * 60 * 1000);
});

// ─── EL INVARIANTE: la rama del softban ───────────────────────────────────────
// hasConnected=false + sesión vinculada = un RECHAZO de WhatsApp, no un cable. Da igual el
// código y da igual el flag: se sale siempre para que entrypoint.sh espacie el reintento.

test('🔒 sin haber conectado y con sesión vinculada, NADA reabre — ni siquiera un 428', () => {
  for (const code of [...Object.values(CIERRE), 405, undefined]) {
    if (code === CIERRE.loggedOut || code === CIERRE.restartRequired) continue;
    for (const hotReopen of [true, false]) {
      const d = decideOnClose({ statusCode: code, hasConnected: false, hasCreds: true, hotReopen });
      assert.equal(d.action, 'exit', `${code} (flag=${hotReopen}) NO puede reabrir antes de conectar`);
      assert.equal(d.code, 1);
    }
  }
});

// ─── Pairing genuino (sin credenciales) ───────────────────────────────────────

test('sin credenciales pide QR de nuevo, con backoff acotado', () => {
  const base = { statusCode: CIERRE.connectionClosed, hasConnected: false, hasCreds: false, maxPairing: 5 };
  assert.deepEqual(
    [0, 1, 2, 3].map((pairingRetries) => decideOnClose({ ...base, pairingRetries }).waitMs),
    [3000, 6000, 12000, 24000]
  );
  assert.equal(decideOnClose({ ...base, pairingRetries: 0 }).action, 'pair');
});

test('el backoff de pairing tiene techo de 60s y el intento se agota', () => {
  const base = { statusCode: CIERRE.connectionClosed, hasConnected: false, hasCreds: false, maxPairing: 5 };
  assert.equal(decideOnClose({ ...base, pairingRetries: 4 }).waitMs, 48000);
  const agotado = decideOnClose({ ...base, pairingRetries: 5 });
  assert.equal(agotado.action, 'exit');
  assert.equal(agotado.code, 1);
});
