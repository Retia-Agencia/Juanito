// test/calendly.closer-de-prueba.test.js
// La identidad de PRUEBA del roster (§18.BB), la que habilita el smoke del setteo.
//
// Vive en su propio archivo porque necesita `TEST_CLOSER_ENABLED=true` ANTES del import, y los
// mapas derivados de closers.js se calculan una sola vez al cargar el módulo. `node --test` corre
// cada archivo en su propio proceso, así que acá se puede ensuciar el entorno sin afectar al
// resto de la suite — donde el gate tiene que verse APAGADO (eso se fija en calendly.closers.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TEST_CLOSER_ENABLED = 'true';
const { CLOSERS, CLOSER_LIDS, resolveCloserByLid, resolveCloserByPhone, workLidForCloser, extraJidsForCloser } =
  await import('../src/calendly/closers.js');
const { roleOf, closerOf } = await import('../src/common/roles.js');

const EMAIL = 'prueba.setteo@30x.com';
const LID = '65756133896221';

test('con el gate prendido, la identidad de prueba entra al roster', () => {
  const c = CLOSERS[EMAIL];
  assert.ok(c, 'la identidad de prueba debe existir con TEST_CLOSER_ENABLED=true');
  assert.equal(c.name, 'Prueba Setteo');
  assert.equal(c.phone, '+573052933190');
  assert.equal(c.account, undefined, 'cuenta default (30x): no debe declarar `account`');
});

test('se la reconoce por su LID, que es como va a llegar el mensaje de verdad', () => {
  // En WhatsApp multi-device el `from` es un `<lid>@lid` opaco. Sin este mapeo el
  // reconocimiento colgaría del pushName del teléfono, que falla EN SILENCIO.
  assert.equal(CLOSER_LIDS[LID], EMAIL);
  assert.equal(resolveCloserByLid(`${LID}@lid`)?.email, EMAIL);
  assert.equal(resolveCloserByPhone('+573052933190')?.email, EMAIL);
  assert.equal(workLidForCloser(EMAIL), `${LID}@lid`);
});

test('el rol que sale de ese LID es `closer`, y su identidad es la de prueba', () => {
  // La prueba entera depende de esto: si `roleOf` no dice `closer`, el mensaje ni siquiera
  // llega al handler que se quiere ejercitar.
  //
  // ⚠️ Se limpian BOSS_LID/ADMIN_LID a propósito: en producción ese LID está en ADMIN_LID y
  // `roleOf` resuelve admin ANTES que closer. Este test fija el comportamiento del roster, no
  // el del `.env` — el paso de sacarlo de ADMIN_LID es parte del runbook del smoke.
  const admin = process.env.ADMIN_LID;
  const bossLid = process.env.BOSS_LID;
  const bossPhone = process.env.BOSS_PHONE;
  process.env.ADMIN_LID = '';
  process.env.BOSS_LID = '144268136038585@lid'; // un jefe cualquiera que NO es este LID
  process.env.BOSS_PHONE = '573105643297';
  try {
    assert.equal(roleOf(`${LID}@lid`), 'closer');
    assert.equal(closerOf(`${LID}@lid`)?.email, EMAIL);
  } finally {
    process.env.ADMIN_LID = admin ?? '';
    process.env.BOSS_LID = bossLid ?? '';
    process.env.BOSS_PHONE = bossPhone ?? '';
  }
});

test('la identidad de prueba NO recibe copias en aparatos secundarios', () => {
  // Nada de §18.BA se le pega por estar en el roster: sin `extraJids` no hay fan-out.
  assert.deepEqual(extraJidsForCloser(EMAIL), []);
});
