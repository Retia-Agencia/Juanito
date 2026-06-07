// test/calendly.helpers.test.js
// Tests de los helpers PUROS de Calendly (sin red, sin DB → corren en Windows).

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';

const {
  firstNameFrom,
  fullNameFrom,
  closerEmailOf,
  prospectPhoneOf,
  buildPush3Message,
  buildDigestMessage,
  push3DueUtc,
  toSqliteUtc,
  dayRangeUtc,
  formatCallTime,
} = await import('../src/calendly/index.js');
const { resolveCloser, resolveCloserByPhone } = await import('../src/calendly/closers.js');

test('firstNameFrom parsea y capitaliza el primer nombre', () => {
  assert.equal(firstNameFrom('maría del pilar yangana '), 'María');
  assert.equal(firstNameFrom('Sebastian Castiblanco'), 'Sebastian');
  assert.equal(firstNameFrom(''), 'el prospecto');
  assert.equal(firstNameFrom(null), 'el prospecto');
});

test('fullNameFrom limpia y capitaliza solo si viene en minúsculas', () => {
  assert.equal(fullNameFrom('maría del pilar yangana '), 'María Del Pilar Yangana');
  assert.equal(fullNameFrom('Sebastian Castiblanco'), 'Sebastian Castiblanco'); // respeta lo escrito
  assert.equal(fullNameFrom('  Juan   Pérez  '), 'Juan Pérez');
  assert.equal(fullNameFrom(''), 'el prospecto');
  assert.equal(fullNameFrom(null), 'el prospecto');
});

test('closerEmailOf saca el host en minúsculas', () => {
  const ev = { event_memberships: [{ user_email: 'Natalia.Gonzalez@30x.com' }] };
  assert.equal(closerEmailOf(ev), 'natalia.gonzalez@30x.com');
  assert.equal(closerEmailOf({}), null);
});

test('prospectPhoneOf usa text_reminder_number (null si vacío)', () => {
  assert.equal(prospectPhoneOf({ text_reminder_number: '+57 312 3884238' }), '+57 312 3884238');
  assert.equal(prospectPhoneOf({ text_reminder_number: null }), null);
  assert.equal(prospectPhoneOf({}), null);
});

test('resolveCloser mapea closers y enruta Equipo EstadoX a Mateo', () => {
  assert.equal(resolveCloser('sebastian.salazar@30x.com').phone, '+573054312905');
  assert.equal(resolveCloser('EQUIPO@estadox.com').phone, '+573003558574'); // case-insensitive
  assert.equal(resolveCloser('mateo.leon@30x.com').phone, '+573003558574');
  assert.equal(resolveCloser('desconocido@x.com'), null);
  assert.equal(resolveCloser(null), null);
});

test('resolveCloserByPhone identifica al closer por su número entrante', () => {
  // con sufijo de WhatsApp y formato distinto
  assert.equal(resolveCloserByPhone('573054312905@s.whatsapp.net').email, 'sebastian.salazar@30x.com');
  assert.equal(resolveCloserByPhone('+57 310 306 2287').name, 'Daniela Camacho');
  assert.equal(resolveCloserByPhone('573003558574').email, 'mateo.leon@30x.com');
  assert.equal(resolveCloserByPhone('573999999999'), null);
  assert.equal(resolveCloserByPhone(''), null);
});

test('push3DueUtc resta el lead time y toSqliteUtc formatea UTC', () => {
  const due = push3DueUtc('2026-06-10T12:30:00Z', 25);
  assert.equal(due.toISOString(), '2026-06-10T12:05:00.000Z');
  assert.equal(toSqliteUtc(due), '2026-06-10 12:05:00');
});

test('dayRangeUtc devuelve fronteras de día en Bogota (UTC-5)', () => {
  const base = new Date('2026-06-05T12:00:00Z'); // 07:00 en Bogota, 5 jun
  const hoy = dayRangeUtc('America/Bogota', 0, base);
  assert.equal(hoy.minStartIso, '2026-06-05T05:00:00.000Z');
  assert.equal(hoy.maxStartIso, '2026-06-06T05:00:00.000Z');
  const manana = dayRangeUtc('America/Bogota', 1, base);
  assert.equal(manana.minStartIso, '2026-06-06T05:00:00.000Z');
  assert.equal(manana.maxStartIso, '2026-06-07T05:00:00.000Z');
});

test('buildPush3Message incluye nombre completo, teléfono y maneja el caso sin teléfono', () => {
  const conTel = buildPush3Message({ name: 'Juan Pérez', phone: '+57 300 111 2222', startIso: '2026-06-10T20:30:00Z' });
  assert.match(conTel, /Push 3/);
  assert.match(conTel, /Juan Pérez/);
  assert.match(conTel, /\+57 300 111 2222/);
  const sinTel = buildPush3Message({ name: 'Ana Gómez', phone: null, startIso: '2026-06-10T20:30:00Z' });
  assert.match(sinTel, /sin teléfono/);
});

test('buildDigestMessage ordena por hora, lista nombre completo y muestra el conteo', () => {
  const msg = buildDigestMessage({
    pushLabel: 'Push 1 (la noche anterior)',
    whenLabel: 'mañana (vie 6 jun)',
    items: [
      { name: 'Beto Ramírez', phone: '+57 1', startIso: '2026-06-06T21:00:00Z' },
      { name: 'Ana Gómez', phone: null, startIso: '2026-06-06T15:00:00Z' },
    ],
  });
  assert.match(msg, /Push 1/);
  assert.match(msg, /tienes 2 llamadas/);
  assert.match(msg, /Beto Ramírez/);
  // Ana (más temprano) debe ir antes que Beto
  assert.ok(msg.indexOf('Ana') < msg.indexOf('Beto'));
  assert.match(msg, /sin teléfono/);
});

test('buildDigestMessage usa singular con una sola llamada', () => {
  const msg = buildDigestMessage({
    pushLabel: 'Push 2 (en la mañana)',
    whenLabel: 'hoy (vie 6 jun)',
    items: [{ name: 'Ana Gómez', phone: '+57 1', startIso: '2026-06-06T15:00:00Z' }],
  });
  assert.match(msg, /tienes 1 llamada\b/);
});

test('formatCallTime formatea en hora local', () => {
  const t = formatCallTime('2026-06-10T12:30:00Z'); // 07:30 en Bogota
  assert.match(t, /30/);
});
