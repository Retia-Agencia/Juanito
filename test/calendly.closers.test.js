// test/calendly.closers.test.js
// El roster de closers y su resolución. No existía un test dedicado: los resolvers solo se
// cubrían de refilón desde los escenarios, y son justo donde muerde sumar closers de otra
// empresa (homónimos, teléfonos repetidos, cuenta equivocada).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  CLOSERS,
  CLOSER_LIDS,
  PEOPLE,
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

test('INVARIANTE: un email = una IDENTIDAD (nunca dos connections con el mismo correo)', () => {
  // CLOSERS se deriva con Object.fromEntries keyeado por email: dos identidades con el MISMO
  // correo no dan error, se pisan — y la que gana decide `accountOfCloser`, que es la regla única
  // de dry-run / push4 / HubSpot. El caso que tienta a romperlo es real: al mudar IA para Abogados
  // al Calendly propio de EstadoX (2026-08-25), Sebastian Salazar quedó hosteando con el mismo
  // sebastian.salazar@30x.com en otra org. Lo correcto fue MOVER su identidad, no duplicarla.
  const vistos = new Map(); // email → connection que lo declaró
  for (const person of Object.values(PEOPLE)) {
    for (const id of person.identities) {
      const email = id.email.toLowerCase();
      const prev = vistos.get(email);
      assert.ok(
        !prev,
        `${email} está declarado en dos connections ('${prev}' y '${id.connection}') — la segunda pisa a la primera en CLOSERS`
      );
      vistos.set(email, id.connection);
    }
  }
  // Y el derivado tiene que tener tantas entradas como identidades hay (si alguna se pisó, sobra
  // una identidad y falta una entrada).
  const totalIdentidades = Object.values(PEOPLE).reduce((n, p) => n + p.identities.length, 0);
  assert.equal(Object.keys(CLOSERS).length, totalIdentidades);
});

test('los closers de IA para Abogados viven en la conexión estadox (mudanza 2026-08-25)', () => {
  // Regresión del mes en blanco: el programa se mudó al Calendly propio de EstadoX y el roster
  // quedó apuntando a la conexión vieja. Si esto se rompe, sus pushes vuelven a resolverse contra
  // el dry-run/HubSpot de 30x y las citas de la org de EstadoX caen como host desconocido.
  assert.equal(accountOfCloser('aguilare@estadox.com'), 'estadox');
  assert.equal(accountOfCloser('sebastian.salazar@30x.com'), 'estadox');
  assert.equal(CLOSERS['aguilare@estadox.com'].name, 'Esteban Aguilar');
  // Salazar conserva su identidad de Retia intacta.
  assert.equal(accountOfCloser('equipo@ttrading.co'), 'retia');
});

test('INVARIANTE: la identidad de PRUEBA no existe si nadie prendió el gate', () => {
  // §18.BB — `TEST_CLOSER_ENABLED` mete un closer desechable al roster para poder hacer el smoke
  // del setteo. Esta es la red que impide que se quede: si algún día alguien borra el `if` y deja
  // la entrada suelta, o la sube con el gate invertido, la suite entera lo dice acá.
  // El comportamiento CON el gate prendido se prueba en calendly.closer-de-prueba.test.js, que
  // corre en su propio proceso.
  assert.equal(process.env.TEST_CLOSER_ENABLED, undefined, 'la suite no debería correr con el gate puesto');
  assert.ok(!CLOSERS['prueba.setteo@30x.com'], 'el closer de prueba se coló al roster real');
  assert.ok(!CLOSER_LIDS['65756133896221'], 'el LID de prueba se coló a CLOSER_LIDS');
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

// Declarar un `workLid` PINNEA la entrega a ese hilo (optin.js: `contactJid = workJid || from`),
// así que un LID repetido mandaría los pushes de dos identidades al mismo WhatsApp. La estructura
// del mapa ya lo impide (lid → email, una entrada por LID), pero el error se cometería al EDITAR
// el roster: copiar la línea de un closer y olvidar cambiarle el LID. Eso se detecta acá.
//
// La otra mitad del invariante (que el LID declarado coincida con el `contact_jid` real del
// opt-in) NO se puede probar acá: compara código contra datos de producción. Vive en
// `scripts/calendly-optins.js`, que corre contra la DB viva.
test('INVARIANTE: ningún workLid se declara dos veces', () => {
  const vistos = new Map();
  for (const p of Object.values(PEOPLE)) {
    for (const id of p.identities) {
      if (!id.workLid) continue;
      const duenio = vistos.get(id.workLid);
      assert.equal(
        duenio,
        undefined,
        `el workLid ${id.workLid} está en ${id.email} y también en ${duenio} — los pushes de ambos irían al mismo hilo`
      );
      vistos.set(id.workLid, id.email);
    }
  }
});

// ─── extraJids: la COPIA a un segundo aparato (2026-08-04) ────────────────────
// Es la única declaración del roster que saltea el gate anti-ban de deliver() (el primario se
// valida contra el `contact_jid` real del opt-in; el secundario, contra el criterio de quien
// edita el archivo). Por eso las invariantes de acá son más estrictas que las de workLid.

test('INVARIANTE: un extraJid nunca es el hilo de OTRA persona', () => {
  // El peor error posible de este campo: copiar los pushes de un closer —con nombres y teléfonos
  // de sus leads— al WhatsApp de otro. Un dígito de menos al transcribir un LID basta.
  const duenioDeLid = new Map(); // lid → nombre de la persona
  for (const p of Object.values(PEOPLE))
    for (const id of p.identities) if (id.workLid) duenioDeLid.set(id.workLid, p.name);

  for (const p of Object.values(PEOPLE)) {
    for (const id of p.identities) {
      for (const jid of id.extraJids || []) {
        const lid = String(jid).split('@')[0];
        const duenio = duenioDeLid.get(lid);
        if (duenio) {
          assert.equal(duenio, p.name, `${id.email} copia a ${jid}, que es el hilo de trabajo de ${duenio}`);
        }
      }
    }
  }
});

test('INVARIANTE: los extraJids tienen forma de JID y no se repiten entre identidades', () => {
  const vistos = new Map();
  for (const p of Object.values(PEOPLE)) {
    for (const id of p.identities) {
      for (const jid of id.extraJids || []) {
        assert.match(jid, /^\d+@(lid|s\.whatsapp\.net)$/, `extraJid "${jid}" (${id.email}) no tiene forma de JID`);
        const duenio = vistos.get(jid);
        assert.equal(duenio, undefined, `el extraJid ${jid} está en ${id.email} y también en ${duenio}`);
        vistos.set(jid, id.email);
      }
    }
  }
});

test('todo extraJid queda RECONOCIDO en CLOSER_LIDS', () => {
  // Recibir en un aparato y no ser reconocido al contestar desde él es la mitad rota de la
  // feature: el Push 4 llega, el closer responde ahí y Juanito lo trata como un desconocido.
  for (const p of Object.values(PEOPLE)) {
    for (const id of p.identities) {
      for (const jid of id.extraJids || []) {
        const lid = String(jid).split('@')[0];
        assert.equal(CLOSER_LIDS[lid], id.email.toLowerCase(), `${jid} no resuelve a ${id.email}`);
        assert.equal(resolveCloserByLid(jid)?.email, id.email.toLowerCase());
      }
    }
  }
});

// ─── resolveCloserByPushName: la ambigüedad que rompe el opt-in en silencio ────

// Nombres AMBIGUOS a propósito: mismo nombre en TELÉFONOS DISTINTOS → pushName resuelve a null
// (seguro), el closer entra por teléfono/LID. "Sebastian Rodriguez" es la misma persona en 30x
// [sebastian@30x.com] y retia [sebasrr321@gmail.com] con DOS números → ambiguo.
// OJO: "Sebastian Salazar" también repite nombre, pero con el MISMO teléfono (30x + retia desde
// una línea) → NO es ambiguo: resuelve a esa persona única. Por eso NO va acá. Cualquier choque
// con teléfonos distintos que NO esté declarado acá debe romper CI.
// "Andrea Machado" entró al club el 2026-08-25: la misma persona atiende el buzón-rol de Retia
// (registro@ttrading.co) y el de ComunicArte (info@eventoscomunicarte.com), con un teléfono
// distinto en cada uno. OJO con el homónimo histórico: andrea.machado@30x.com es otra persona,
// DEPARTIDA y en IGNORED_CLOSERS, así que no entra en este conteo.
const HOMONIMOS_OK = new Set(['Sebastian Rodriguez', 'Andrea Machado']);

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

// pushNames REALES de producción. El roster guarda el nombre corto a propósito (ej. "Sebastian
// Marin", no "Juan Sebastian Marin") y el match es por contención, así que un nombre extra
// adelante o un sufijo de empresa atrás no estorban. Vale fijarlo porque cuando esto falla, falla
// EN SILENCIO: el closer escribe, no se registra, y Juanito tampoco le contesta nada.
//
// Marín dependió enteramente de esto entre el 2026-07-30 (rotación de línea, sin `workLid`) y el
// 2026-08-04, cuando se le declararon sus dos LIDs. Se mantiene fijado: el pushName sigue siendo
// la red si algún día cambia de aparato otra vez.
test('resolveCloserByPushName tolera nombres extra y sufijos (pushNames reales)', () => {
  for (const nombre of ['Juan Sebastian Marin - 30X', 'Juan Sebastian Marín - 30X']) {
    assert.equal(
      resolveCloserByPushName(nombre)?.email,
      'sebastian.marin@30x.com',
      `"${nombre}" debe resolver a Marín — si no, su opt-in falla en silencio`
    );
  }
  // Sin apellido no hay match: una sola palabra es ambigua por diseño.
  assert.equal(resolveCloserByPushName('Juan Sebastian'), null);
  assert.equal(resolveCloserByPushName('Marin'), null);
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

test('resolveIdentitiesByName lista las DOS identidades aunque compartan teléfono (Maru Marquez)', () => {
  // Maru cierra en comunicarte y en retia desde la MISMA línea. El dedup es por (teléfono,
  // cuenta), no por teléfono, así que aparecen las dos → `/calendly off Maru Marquez retia`
  // puede apagar solo una. (Si el dedup volviera a ser por teléfono, esto devolvería 1 y el
  // comando no podría desambiguar por cuenta.)
  // Este caso lo encarnaba Sebastian Salazar (estadox + retia) hasta el 2026-09-02, cuando Retia
  // le reasignó el buzón-rol de Tactical Investor a Maru y él quedó con una sola identidad.
  const ids = resolveIdentitiesByName('Maru Marquez');
  assert.equal(ids.length, 2, 'Maru Marquez debe tener 2 identidades');
  assert.deepEqual(ids.map((i) => i.account).sort(), ['comunicarte', 'retia']);
  assert.equal(new Set(ids.map((i) => i.phone)).size, 1, 'ambas identidades comparten teléfono');
  assert.deepEqual(
    ids.map((i) => i.email).sort(),
    ['equipo@ttrading.co', 'soymarumarquez@gmail.com']
  );
});

test('Sebastian Salazar quedó con UNA sola identidad al salir de Tactical Investor', () => {
  // 2026-09-02: Retia le reasignó el buzón-rol `equipo@ttrading.co` a Maru. Su identidad de
  // abogados (estadox) NO se toca, y su opt-in tampoco — sigue activo en su propio programa.
  const ids = resolveIdentitiesByName('Sebastian Salazar');
  assert.deepEqual(ids.map((i) => i.email), ['sebastian.salazar@30x.com']);
  assert.equal(ids[0].account, 'estadox');
  assert.ok(!CLOSERS['equipo@ttrading.co'] || CLOSERS['equipo@ttrading.co'].name !== 'Sebastian Salazar',
    'el buzón ya no puede resolver a Salazar: sus pushes irían al WhatsApp equivocado');
});

test('el buzón-rol equipo@ttrading.co es la identidad retia de Maru, NO un host ignorado', () => {
  // Regresión del 2026-07-29: del 22 al 29 de julio equipo@ estuvo en IGNORED_CLOSERS porque se
  // asumió que su ocupante de entonces (Salazar) tendría cuenta personal en el Calendly de Retia.
  // Nunca se creó, así que sus citas caían en el skip SILENCIOSO del poll (sin log ni alerta) y
  // estuvo una semana sin pushes. Rotar la PERSONA del buzón no puede volver a retirar el CORREO:
  // el buzón sigue vivo y tomando citas, solo cambia quién está detrás.
  assert.ok(!isIgnoredCloser('equipo@ttrading.co'), 'equipo@ NO debe estar en IGNORED_CLOSERS');
  const c = CLOSERS['equipo@ttrading.co'];
  assert.ok(c, 'equipo@ debe estar en CLOSERS');
  assert.equal(c.name, 'Maru Marquez');
  assert.equal(c.account, 'retia');
  // Mismo teléfono que su identidad de ComunicArte: una sola línea de WhatsApp, un solo opt-in.
  assert.equal(c.phone, CLOSERS['soymarumarquez@gmail.com'].phone);
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
