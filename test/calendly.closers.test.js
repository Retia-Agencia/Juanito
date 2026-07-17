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

test('INVARIANTE: un teléfono = un closer = una cuenta', () => {
  // La DB la asume: calendly_optins.phone es PRIMARY KEY y getActiveOutcomeForCloser
  // enruta solo por teléfono. Dos closers con el mismo número se pisan el opt-in.
  const porTelefono = new Map();
  for (const [email, c] of Object.entries(CLOSERS)) {
    const prev = porTelefono.get(c.phone);
    assert.ok(!prev, `${email} y ${prev} comparten el teléfono ${c.phone}`);
    porTelefono.set(c.phone, email);
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

test('NINGÚN closer con nombre completo es ambiguo por pushName', () => {
  // resolveCloserByPushName devuelve null ante ambigüedad → el opt-in falla SIN LOG y
  // `/calendly off <nombre>` responde "no reconozco al closer". Ya pasó con los dos
  // Sebastians. Al sumar closers de otra empresa, un homónimo rompe a AMBOS. Este test
  // es la red: falla en CI el día que alguien agregue un nombre que choque.
  for (const [email, c] of Object.entries(CLOSERS)) {
    if (c.name.trim().split(/\s+/).length < 2) continue; // los de una palabra: test aparte
    const hit = resolveCloserByPushName(c.name);
    assert.ok(hit, `"${c.name}" (${email}) no resuelve por pushName — ¿homónimo en el roster?`);
    assert.equal(hit.email, email, `"${c.name}" resuelve al closer equivocado (${hit.email})`);
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

// ─── Los otros resolvers ──────────────────────────────────────────────────────

test('resolveCloser resuelve por email y tolera mayúsculas/espacios', () => {
  const email = Object.keys(CLOSERS)[0];
  assert.equal(resolveCloser(email).name, CLOSERS[email].name);
  assert.equal(resolveCloser(email.toUpperCase()).name, CLOSERS[email].name);
  assert.equal(resolveCloser('nadie@ejemplo.com'), null);
  assert.equal(resolveCloser(null), null);
});

test('resolveCloserByPhone encuentra a cada closer por su número canónico', () => {
  for (const [email, c] of Object.entries(CLOSERS)) {
    assert.equal(resolveCloserByPhone(c.phone)?.email, email);
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
