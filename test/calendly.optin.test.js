// test/calendly.optin.test.js
// El CONTRATO de handleCloserOptin con el router (src/index.js), que es donde se rompió:
// devuelve true para TODO mensaje de un closer conocido —no solo el primero—, así que el
// router lo usa como "no sigas bajando". El modo `consume:false` (§18.AV) es lo que permite
// que el mensaje siga a los handlers de abajo (captura de setteo + contexto agéntico del
// closer) SIN perder el registro del opt-in, que es lo que re-pinea el contact_jid.
//
// El bug que estos tests congelan: con `consume:true` para todos, handleCloserMessage era
// inalcanzable y el closer del piloto se quedaba sin respuesta a cualquier cosa que no fuera
// un reporte parseable ("¿cómo voy?", "borrá el de Juan").
//
// REQUIERE better-sqlite3 nativo → corre en Docker/VPS, no en Windows.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'optin-'));
const DB_PATH = join(dir, 'test.sqlite');
process.env.DB_PATH = DB_PATH;

let handleCloserOptin;
let markIfNew;
let isOptedIn;
let jidDeUnCloser;
let closer;

before(async () => {
  execFileSync('node', ['src/db/migrate.js'], { env: { ...process.env, DB_PATH }, stdio: 'pipe' });
  ({ handleCloserOptin } = await import('../src/calendly/optin.js'));
  ({ markIfNew, isOptedIn } = await import('../src/db/index.js'));
  // Un closer REAL del roster: si el roster cambia, el test sigue siendo válido.
  const { CLOSERS } = await import('../src/calendly/closers.js');
  const [email, c] = Object.entries(CLOSERS)[0];
  closer = { email, ...c };
  jidDeUnCloser = `${String(c.phone).replace(/\D/g, '')}@s.whatsapp.net`;
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('consume:true (default) — consume el mensaje SIEMPRE, no solo el primero', async () => {
  // Primer mensaje del closer: se registra.
  assert.equal(await handleCloserOptin({ from: jidDeUnCloser, messageId: 'optin-1' }), true);
  assert.equal(isOptedIn(closer.phone), true);

  // Segundo mensaje, ya registrado: SIGUE devolviendo true. Esta es la premisa que el
  // comentario del router daba por falsa ("solo consume el PRIMER mensaje").
  assert.equal(await handleCloserOptin({ from: jidDeUnCloser, messageId: 'optin-2' }), true);
});

test('consume:true reclama el dedup — el handler de abajo vería el mensaje como duplicado', async () => {
  assert.equal(await handleCloserOptin({ from: jidDeUnCloser, messageId: 'optin-3' }), true);
  // markIfNew ya no lo deja pasar: el slot está tomado. Por eso el modo consume:false existe.
  assert.equal(markIfNew('optin-3'), false);
});

test('consume:false — registra pero NO consume ni reclama el dedup (§18.AV)', async () => {
  const r = await handleCloserOptin({ from: jidDeUnCloser, messageId: 'optin-4', consume: false });
  assert.equal(r, false, 'el router tiene que poder seguir bajando al contexto agéntico');
  // El slot de dedup queda libre para el handler que de verdad responde.
  assert.equal(markIfNew('optin-4'), true, 'el opt-in se robó el dedup: el closer no recibiría respuesta');
  // Y el registro se hizo igual: es lo que decide a dónde salen los pushes (§18.AR).
  assert.equal(isOptedIn(closer.phone), true);
});

test('consume:false no cambia nada para quien NO es del roster', async () => {
  const r = await handleCloserOptin({ from: '573000000000@s.whatsapp.net', messageId: 'optin-5', consume: false });
  assert.equal(r, false);
  assert.equal(markIfNew('optin-5'), true, 'a un desconocido no se le toca el dedup');
});
