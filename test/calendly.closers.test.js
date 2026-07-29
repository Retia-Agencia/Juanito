// test/calendly.closers.test.js
// El roster de closers y su resolución. No existía un test dedicado: los resolvers solo se
// cubrían de refilón desde los escenarios, y son justo donde muerde sumar closers de otra
// empresa (homónimos, teléfonos repetidos, cuenta equivocada).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  CLOSERS,
  CLOSER_LIDS,
  accountOfCloser,
  resolveCloser,
  resolveCloserByPhone,
  resolveCloserByLid,
  resolveCloserByPushName,
  resolveIdentitiesByName,
  isIgnoredCloser,
  IGNORED_CLOSERS,
} = await import('../src/calendly/closers.js');
const { ACCOUNTS, DEFAULT_ACCOUNT } = await import('../src/calendly/accounts.js');

// ─── accountOfCloser: la regla con la que se decide TODO lo que sale ───────────

test('un closer sin campo `account` cae a la cuenta default', () => {
  // Los 7 del equipo original no declaran cuenta → 30x. Si esto se rompe, el equipo
  // entero cambia de cuenta y hereda su dry-run/push4.
  for (const email of Object.keys(CLOSERS)) {
    if (CLOSERS[email].account) continue;
    assert.equal(accountOfCloser(email), DEFAULT_ACCOUNT, `${email} debería caer a la default`);
  }
});

test('accountOfCloser respeta el campo `account` cuando existe', () => {
  const conCuenta = Object.entries(CLOSERS).filter(([, c]) => c.account);
  for (const [email, c] of conCuenta) {
    assert.equal(accountOfCloser(email), c.account);
  }
});

test('accountOfCloser normaliza y tolera basura', () => {
  const email = Object.keys(CLOSERS)[0];
  assert.equal(accountOfCloser(email.toUpperCase()), accountOfCloser(email));
  assert.equal(accountOfCloser(`  ${email}  `), accountOfCloser(email));
  // Desconocido → default. Nunca undefined: el caller lo usa para elegir cuenta.
  assert.equal(accountOfCloser('nadie@ejemplo.com'), DEFAULT_ACCOUNT);
  assert.equal(accountOfCloser(null), DEFAULT_ACCOUNT);
  assert.equal(accountOfCloser(''), DEFAULT_ACCOUNT);
});

test('toda cuenta declarada por un closer existe en el registro', () => {
  // Un typo acá haría que accountOf() devuelva null → el scheduler caería al DRY_RUN
  // global y el closer podría recibir (o no) por la razón equivocada.
  for (const [email, c] of Object.entries(CLOSERS)) {
    if (!c.account) continue;
    assert.ok(ACCOUNTS[c.account], `${email} apunta a la cuenta inexistente "${c.account}"`);
  }
});

// ─── Integridad del roster ────────────────────────────────────────────────────

test('INVARIANTE: un teléfono = una PERSONA (nunca dos personas distintas)', () => {
  // La DB asume calendly_optins.phone como PRIMARY KEY: DOS personas distintas con el mismo número
  // se pisarían el opt-in. UNA misma persona SÍ puede repetir teléfono en dos identidades de
  // Conexiones distintas (Sebastian Salazar: 30x + retia desde una sola línea) — válido, y una
  // sola fila de opt-in les sirve. Ver la invariante revisada en closers.js.
  const porTelefono = new Map(); // phone → nombre de la persona
  for (const [email, c] of Object.entries(CLOSERS)) {
    const prev = porTelefono.get(c.phone);
    if (prev) {
      assert.equal(prev, c.name, `${email} comparte el teléfono ${c.phone} con OTRA persona (${prev}) — se pisarían el opt-in`);
    }
    porTelefono.set(c.phone, c.name);
  }
});

test('ningún closer está a la vez en CLOSERS y en IGNORED_CLOSERS', () => {
  // Estar en ambos es contradictorio: uno dice "gestionar", el otro "ignorar en silencio".
  for (const email of Object.keys(CLOSERS)) {
    assert.ok(!isIgnoredCloser(email), `${email} está en CLOSERS y en IGNORED_CLOSERS`);
  }
});

test('los emails del roster están normalizados (minúsculas, sin espacios)', () => {
  // resolveCloser hace lookup directo tras bajar a minúsculas: una key con mayúsculas
  // sería inalcanzable y su closer nunca recibiría push.
  for (const email of [...Object.keys(CLOSERS), ...IGNORED_CLOSERS]) {
    assert.equal(email, email.toLowerCase().trim(), `"${email}" no está normalizado`);
  }
});

test('CLOSER_LIDS apunta solo a emails que existen en CLOSERS', () => {
  for (const [lid, email] of Object.entries(CLOSER_LIDS)) {
    assert.ok(CLOSERS[email], `el LID ${lid} apunta a "${email}", que no está en CLOSERS`);
    assert.match(lid, /^\d+$/, `el LID ${lid} debe ser solo dígitos (sin @lid)`);
  }
});

// ─── resolveCloserByPushName: la ambigüedad que rompe el opt-in en silencio ────

// Nombres AMBIGUOS a propósito: mismo nombre en TELÉFONOS DISTINTOS → pushName resuelve a null
// (seguro), el closer entra por teléfono/LID. "Sebastian Rodriguez" es la misma persona en 30x
// [sebastian@30x.com] y retia [sebasrr321@gmail.com] con DOS números → ambiguo.
// OJO: "Sebastian Salazar" también repite nombre, pero con el MISMO teléfono (30x + retia desde
// una línea) → NO es ambiguo: resuelve a esa persona única. Por eso NO va acá. Cualquier choque
// con teléfonos distintos que NO esté declarado acá debe romper CI.
const HOMONIMOS_OK = new Set(['Sebastian Rodriguez']);

test('resolveCloserByPushName: nombre completo resuelve a la persona correcta (o null si es ambiguo)', () => {
  // resolveCloserByPushName devuelve null ante ambigüedad REAL (mismo nombre, teléfonos distintos)
  // → el opt-in por nombre falla SIN LOG y `/calendly off <nombre>` responde "no reconozco". Este
  // test es la red: falla en CI si aparece un choque con teléfonos distintos sin declarar, o si un
  // nombre único deja de resolver.
  const porNombre = new Map(); // name → Set<phone>
  for (const c of Object.values(CLOSERS)) {
    if (!porNombre.has(c.name)) porNombre.set(c.name, new Set());
    porNombre.get(c.name).add(c.phone);
  }
  for (const [email, c] of Object.entries(CLOSERS)) {
    if (c.name.trim().split(/\s+/).length < 2) continue; // los de una palabra: test aparte
    const hit = resolveCloserByPushName(c.name);
    if (porNombre.get(c.name).size > 1) {
      // Mismo nombre en teléfonos DISTINTOS → ambiguo → null (debe estar declarado intencional).
      assert.ok(HOMONIMOS_OK.has(c.name), `"${c.name}" choca con teléfonos distintos sin declararse en HOMONIMOS_OK`);
      assert.equal(hit, null, `"${c.name}" es ambiguo (teléfonos distintos) → debe resolver a null, resolvió a ${hit?.email}`);
    } else {
      // Nombre único, o mismo nombre pero MISMO teléfono (una persona, varias Conexiones):
      // resuelve a esa persona (un teléfono, un opt-in). Verificamos por TELÉFONO, no por email.
      assert.ok(hit, `"${c.name}" (${email}) no resuelve por pushName — ¿homónimo nuevo con teléfono distinto? Si es intencional, agrégalo a HOMONIMOS_OK.`);
      assert.equal(hit.phone, c.phone, `"${c.name}" resuelve a otra persona (${hit.email})`);
    }
  }
});

test('un closer de nombre único NO se resuelve por pushName (ni él ni un extraño)', () => {
  // Por qué importa: handleCloserOptin le pone al opt-in del closer el contact_jid de QUIEN
  // ESCRIBIÓ. Si un desconocido llamado "Andrea Restrepo" le escribe a Juanito y matchea a
  // la closer "Andrea", TODOS los pushes de Andrea (con nombres y teléfonos de sus leads)
  // se van a ese desconocido. Preferimos que ese closer no se auto-registre (se resuelve por
  // teléfono, o se mapea su LID en CLOSER_LIDS) antes que filtrarle datos a un tercero.
  const unaPalabra = Object.entries(CLOSERS).filter(
    ([, c]) => c.name.trim().split(/\s+/).length < 2
  );
  for (const [email, c] of unaPalabra) {
    assert.equal(
      resolveCloserByPushName(c.name),
      null,
      `"${c.name}" (${email}) se resuelve por pushName: un extraño con esa palabra en su nombre de WhatsApp secuestraría sus pushes`
    );
  }
  // El caso concreto que motivó el guard (falla si alguien quita el chequeo):
  assert.equal(resolveCloserByPushName('Dana Beauty Salon'), null);
  assert.equal(resolveCloserByPushName('Andrea Restrepo (Contadora)'), null);
  assert.equal(resolveCloserByPushName('Juan Andrea'), null);
});

test('resolveCloserByPushName normaliza acentos y adornos del nombre de WhatsApp', () => {
  // El pushName real casi siempre trae tilde y a veces sufijos: "Pablo Suárez (EstadoX) 🚀".
  const pablo = resolveCloserByPushName('Pablo Suárez');
  assert.equal(pablo?.email, 'pablosuarez@30x.com');
  assert.equal(resolveCloserByPushName('Pablo Suárez (EstadoX)')?.email, 'pablosuarez@30x.com');
});

test('resolveCloserByPushName exige el nombre COMPLETO', () => {
  // Con dos Sebastians, el nombre de pila solo es ambiguo → null (y no un match al azar).
  assert.equal(resolveCloserByPushName('Sebastian'), null);
  assert.equal(resolveCloserByPushName(''), null);
  assert.equal(resolveCloserByPushName(null), null);
  assert.equal(resolveCloserByPushName('Persona Inexistente'), null);
});

// ─── resolveIdentitiesByName: la LISTA que usa /calendly para desambiguar ──────

test('resolveIdentitiesByName devuelve TODAS las identidades de una persona multi-cuenta', () => {
  // Donde resolveCloserByPushName colapsa a null (ambiguo), este devuelve la lista para que el
  // dev elija cuenta. Sebastian Rodriguez cierra en 30x y en retia → dos identidades.
  const ids = resolveIdentitiesByName('Sebastian Rodriguez');
  assert.equal(ids.length, 2, 'Sebastian Rodriguez debe tener 2 identidades');
  const cuentas = ids.map((i) => i.account).sort();
  assert.deepEqual(cuentas, ['30x', 'retia']);
  // Cada identidad trae el label de su Conexión (para que el dev sepa cuál apaga).
  for (const i of ids) {
    assert.ok(i.email && i.phone && i.accountLabel, 'identidad incompleta');
    assert.equal(i.accountLabel, ACCOUNTS[i.account].label);
  }
});

test('resolveIdentitiesByName lista las DOS identidades aunque compartan teléfono (Sebastian Salazar)', () => {
  // Salazar cierra en 30x y retia desde la MISMA línea. El dedup es por (teléfono, cuenta), no por
  // teléfono, así que aparecen las dos → `/calendly off Sebastian Salazar retia` puede apagar solo
  // una. (Si el dedup volviera a ser por teléfono, esto devolvería 1 y el comando no podría
  // desambiguar por cuenta.)
  const ids = resolveIdentitiesByName('Sebastian Salazar');
  assert.equal(ids.length, 2, 'Sebastian Salazar debe tener 2 identidades');
  assert.deepEqual(ids.map((i) => i.account).sort(), ['30x', 'retia']);
  assert.equal(new Set(ids.map((i) => i.phone)).size, 1, 'ambas identidades comparten teléfono');
  assert.deepEqual(
    ids.map((i) => i.email).sort(),
    ['equipo@ttrading.co', 'sebastian.salazar@30x.com']
  );
});

test('el buzón-rol equipo@ttrading.co es la identidad retia de Salazar, NO un host ignorado', () => {
  // Regresión del 2026-07-29: del 22 al 29 de julio equipo@ estuvo en IGNORED_CLOSERS porque se
  // asumió que Salazar tendría cuenta personal en el Calendly de Retia. Nunca se creó, así que sus
  // citas caían en el skip SILENCIOSO del poll (sin log ni alerta) y estuvo una semana sin pushes.
  assert.ok(!isIgnoredCloser('equipo@ttrading.co'), 'equipo@ NO debe estar en IGNORED_CLOSERS');
  const c = CLOSERS['equipo@ttrading.co'];
  assert.ok(c, 'equipo@ debe estar en CLOSERS');
  assert.equal(c.name, 'Sebastian Salazar');
  assert.equal(c.account, 'retia');
  // Mismo teléfono que su identidad 30x: una sola línea de WhatsApp, un solo opt-in.
  assert.equal(c.phone, CLOSERS['sebastian.salazar@30x.com'].phone);
});

test('el correo personal que nunca existió en Calendly no quedó en el roster', () => {
  assert.ok(!CLOSERS['sebastiansalazar1410@gmail.com'], 'el correo fantasma no debe estar en CLOSERS');
});

test('resolveIdentitiesByName de un closer de identidad única devuelve exactamente una', () => {
  const ids = resolveIdentitiesByName('Pablo Lozano');
  assert.equal(ids.length, 1);
  assert.equal(ids[0].email, 'pablo.lozano@30x.com');
  assert.equal(ids[0].account, DEFAULT_ACCOUNT); // la default nunca queda sin account acá
});

test('resolveIdentitiesByName exige nombre completo y tolera desconocidos', () => {
  assert.deepEqual(resolveIdentitiesByName('Sebastian'), []); // una palabra: ambiguo → nada
  assert.deepEqual(resolveIdentitiesByName('Persona Inexistente'), []);
  assert.deepEqual(resolveIdentitiesByName(''), []);
  assert.deepEqual(resolveIdentitiesByName(null), []);
});

// ─── Los otros resolvers ──────────────────────────────────────────────────────

test('resolveCloser resuelve por email y tolera mayúsculas/espacios', () => {
  const email = Object.keys(CLOSERS)[0];
  assert.equal(resolveCloser(email).name, CLOSERS[email].name);
  assert.equal(resolveCloser(email.toUpperCase()).name, CLOSERS[email].name);
  assert.equal(resolveCloser('nadie@ejemplo.com'), null);
  assert.equal(resolveCloser(null), null);
});

test('resolveCloserByPhone encuentra a la PERSONA correcta por su número canónico', () => {
  // Para identidades que comparten teléfono (una persona, dos Conexiones: Sebastian Salazar)
  // resuelve a UNA de ellas — la misma persona —: correcto, porque el opt-in que crearía va por
  // ese teléfono y sirve a las dos. Verificamos por teléfono + nombre, no por email.
  for (const [email, c] of Object.entries(CLOSERS)) {
    const hit = resolveCloserByPhone(c.phone);
    assert.ok(hit, `${email} no resuelve por su teléfono ${c.phone}`);
    assert.equal(hit.phone, c.phone);
    assert.equal(hit.name, c.name, `${c.phone} resuelve a otra persona (${hit.name})`);
  }
  assert.equal(resolveCloserByPhone('+573009998877'), null);
  assert.equal(resolveCloserByPhone(null), null);
});

test('resolveCloserByLid acepta el JID completo o solo los dígitos', () => {
  const [lid, email] = Object.entries(CLOSER_LIDS)[0];
  assert.equal(resolveCloserByLid(`${lid}@lid`)?.email, email);
  assert.equal(resolveCloserByLid(lid)?.email, email);
  assert.equal(resolveCloserByLid('999999999999@lid'), null);
  assert.equal(resolveCloserByLid(null), null);
});
