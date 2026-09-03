// test/commands.espejo.test.js
// /espejo (§18.BV): el alcance del espejo de dev, movible desde el DM y sin redeploy.
//
// Lo que protege este archivo son tres propiedades, y ninguna es cosmética:
//   1. El comando PISA al .env, y la distinción null/'' se respeta: '' es "apagado por comando",
//      no "no configurado". Si se confunden, `/espejo off` no apaga nada y el dev sigue recibiendo
//      copias de una agencia que ya verificó (que es el bug que este comando viene a evitar).
//   2. El DESTINO no se toca por comando. El alcance dice de quiénes se copian los mensajes; el
//      JID dice a quién le llegan. Un DM que redirige datos de clientes a un número arbitrario es
//      otra clase de riesgo → sigue viviendo en el .env.
//   3. Es solo de admins, como /calendly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { handleCommand } = await import('../src/bot/commands.js');

// Doble de la DB: guarda el CSV como lo haría `settings`. `null` = nadie lo tocó todavía.
function espejoDeps(inicial = null) {
  const box = { value: inicial };
  return {
    box,
    getMirrorConnections: () => box.value,
    setMirrorConnections: (csv) => {
      box.value = csv == null ? '' : String(csv);
    },
  };
}

function withEnv(conns, jid, fn) {
  const savedC = process.env.CALENDLY_DEV_MIRROR_CONNECTIONS;
  const savedJ = process.env.CALENDLY_DEV_MIRROR_JID;
  if (conns === undefined) delete process.env.CALENDLY_DEV_MIRROR_CONNECTIONS;
  else process.env.CALENDLY_DEV_MIRROR_CONNECTIONS = conns;
  if (jid === undefined) delete process.env.CALENDLY_DEV_MIRROR_JID;
  else process.env.CALENDLY_DEV_MIRROR_JID = jid;
  try {
    return fn();
  } finally {
    if (savedC === undefined) delete process.env.CALENDLY_DEV_MIRROR_CONNECTIONS;
    else process.env.CALENDLY_DEV_MIRROR_CONNECTIONS = savedC;
    if (savedJ === undefined) delete process.env.CALENDLY_DEV_MIRROR_JID;
    else process.env.CALENDLY_DEV_MIRROR_JID = savedJ;
  }
}

const espejo = (text, deps, role = 'admin') =>
  handleCommand({ text, sender: 'a@lid', role }, deps);

test('/espejo para no-admin → deflexión (no expone a quién se le copian los pushes)', async () => {
  const d = espejoDeps('comunicarte');
  assert.match(await espejo('/espejo', d, 'boss'), /equipo técnico/);
  assert.match(await espejo('/espejo off comunicarte', d, 'unknown'), /equipo técnico/);
  assert.equal(d.box.value, 'comunicarte', 'un no-admin no puede cambiar el alcance');
});

test('/espejo sin nada configurado hereda el alcance del .env y lo dice', async () => {
  await withEnv('comunicarte,retia', '999@lid', async () => {
    const out = await espejo('/espejo', espejoDeps(null));
    assert.match(out, /Retia · ComunicArte \(comunicarte\)/);
    assert.match(out, /Retia \(retia\)/);
    assert.match(out, /heredado del \.env/i);
    assert.match(out, /999/); // el destino se muestra…
    assert.match(out, /no se cambia por comando/i); // …pero se declara inmutable desde acá
  });
});

test('/espejo off <conexión> saca solo esa y deja el resto (el caso ComunicArte→Tactical)', async () => {
  await withEnv('comunicarte,retia', '999@lid', async () => {
    const d = espejoDeps(null);
    const out = await espejo('/espejo off comunicarte', d);
    assert.match(out, /fuera del espejo/);
    assert.equal(d.box.value, 'retia');
    assert.match(await espejo('/espejo', d), /Espejando: Retia \(retia\)/);
  });
});

test('/espejo off a secas apaga TODO, y el .env deja de mandar (null ≠ "")', async () => {
  await withEnv('comunicarte,retia', '999@lid', async () => {
    const d = espejoDeps(null);
    assert.match(await espejo('/espejo off', d), /APAGADO/);
    assert.equal(d.box.value, '', 'apagado por comando se guarda como cadena vacía');
    const out = await espejo('/espejo', d);
    assert.match(out, /Espejando: nada/);
    assert.match(out, /fijado con \/espejo/i);
  });
});

test('/espejo on acepta un PROGRAMA y avisa que espeja la conexión entera', async () => {
  await withEnv('', '999@lid', async () => {
    const d = espejoDeps(null);
    const out = await espejo('/espejo on tactical', d);
    assert.equal(d.box.value, 'retia');
    assert.match(out, /Tactical Investor/);
    assert.match(out, /conexión entera/i);
  });
});

test('/espejo on de algo que no existe no toca nada y lista las conexiones', async () => {
  await withEnv('retia', '999@lid', async () => {
    const d = espejoDeps(null);
    const out = await espejo('/espejo on no_existe', d);
    assert.match(out, /No reconozco/);
    assert.match(out, /Conexiones:/);
    assert.equal(d.box.value, null, 'un argumento inválido no escribe en settings');
  });
});

test('/espejo off de una conexión que no estaba no borra las que sí', async () => {
  await withEnv('retia', '999@lid', async () => {
    const d = espejoDeps(null);
    const out = await espejo('/espejo off 30x', d);
    assert.match(out, /no estaba en el espejo/);
    assert.equal(d.box.value, null);
  });
});

test('/espejo on repetido es idempotente (no duplica la conexión)', async () => {
  await withEnv('', '999@lid', async () => {
    const d = espejoDeps(null);
    await espejo('/espejo on retia', d);
    const out = await espejo('/espejo on retia', d);
    assert.match(out, /ya estaba/i);
    assert.equal(d.box.value, 'retia');
  });
});

test('sin CALENDLY_DEV_MIRROR_JID el estado avisa que el espejo no existe', async () => {
  await withEnv('retia', undefined, async () => {
    assert.match(await espejo('/espejo', espejoDeps(null)), /SIN destino/);
  });
});
