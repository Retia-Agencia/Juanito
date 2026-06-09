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
  buildPrecallText,
  buildLeadLink,
  programKeyOf,
  eventJoinUrl,
  push3DueUtc,
  toSqliteUtc,
  dayRangeUtc,
  formatCallTime,
} = await import('../src/calendly/index.js');

const SECOND_BRAIN_ET = 'https://api.calendly.com/event_types/56efc028-ee2f-46e8-852c-e50d45b15b83';
const ABOGADOS_ET = 'https://api.calendly.com/event_types/f8d123ac-364b-47f9-a446-1316fdf37b08';
const { resolveCloser, resolveCloserByPhone, resolveCloserByPushName } = await import('../src/calendly/closers.js');

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

test('resolveCloserByPushName resuelve por nombre completo e ignora ambigüedades', () => {
  // Nombres exactos
  assert.equal(resolveCloserByPushName('Pablo Lozano').email, 'pablo.lozano@30x.com');
  assert.equal(resolveCloserByPushName('Daniela Camacho').name, 'Daniela Camacho');
  // Case insensitive y con emojis
  assert.equal(resolveCloserByPushName('pablo lozano 📞').phone, '+573046131437');
  // Mateo Leon (dedup con Equipo EstadoX, mismo teléfono)
  assert.equal(resolveCloserByPushName('Mateo Leon').phone, '+573003558574');
  // Dos Sebastians — "Sebastian" solo es ambiguo → null
  assert.equal(resolveCloserByPushName('Sebastian'), null);
  // Con apellido → resuelve unívocamente
  assert.equal(resolveCloserByPushName('Sebastian Salazar').email, 'sebastian.salazar@30x.com');
  assert.equal(resolveCloserByPushName('Sebastian Rodriguez').email, 'sebastian@30x.com');
  // No reconocido → null
  assert.equal(resolveCloserByPushName('Juan Desconocido'), null);
  assert.equal(resolveCloserByPushName(''), null);
  assert.equal(resolveCloserByPushName(null), null);
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
    pushN: 1,
    closer: 'Sebastian',
    items: [
      { name: 'Beto Ramírez', firstName: 'Beto', phone: '+57 1', startIso: '2026-06-06T21:00:00Z', programKey: 'second_brain' },
      { name: 'Ana Gómez', firstName: 'Ana', phone: null, startIso: '2026-06-06T15:00:00Z', programKey: 'second_brain' },
    ],
  });
  assert.match(msg, /Push 1/);
  assert.match(msg, /tienes 2 llamadas/);
  assert.match(msg, /Beto Ramírez/);
  // Ana (más temprano) debe ir antes que Beto
  assert.ok(msg.indexOf('Ana') < msg.indexOf('Beto'));
  // Ana no tiene teléfono → se lista pero sin link, marcada para envío manual
  assert.match(msg, /sin teléfono/);
  assert.match(msg, /mándalo manual/);
  // Beto sí tiene teléfono → lleva su link wa.me con el push precall listo
  assert.match(msg, /https:\/\/wa\.me\/571\?text=/);
});

test('buildDigestMessage usa singular con una sola llamada', () => {
  const msg = buildDigestMessage({
    pushLabel: 'Push 2 (en la mañana)',
    whenLabel: 'hoy (vie 6 jun)',
    pushN: 2,
    closer: 'Sebastian',
    items: [{ name: 'Ana Gómez', firstName: 'Ana', phone: '+57 1', startIso: '2026-06-06T15:00:00Z', programKey: 'second_brain' }],
  });
  assert.match(msg, /tienes 1 llamada\b/);
});

test('buildDigestMessage elige el copy por producto en cada línea (digest mixto)', () => {
  const msg = buildDigestMessage({
    pushLabel: 'Push 1 (la noche anterior)',
    whenLabel: 'mañana',
    pushN: 1,
    closer: 'Sebastian',
    items: [
      { name: 'Ana Gómez', firstName: 'Ana', phone: '+57 1', startIso: '2026-06-06T15:00:00Z', programKey: 'second_brain' },
      { name: 'Beto Ruiz', firstName: 'Beto', phone: '+57 2', startIso: '2026-06-06T16:00:00Z', programKey: 'abogados' },
    ],
  });
  const links = msg.match(/https:\/\/wa\.me\/\S+/g);
  assert.equal(links.length, 2);
  const decoded = links.map((l) => decodeURIComponent(l.split('?text=')[1]));
  // El de Ana (second_brain) menciona 30X; el de Beto (abogados) menciona EstadoX.
  const ana = decoded.find((t) => /Hola Ana/.test(t));
  const beto = decoded.find((t) => /Hola Beto/.test(t));
  assert.match(ana, /Andrés Bilbao en 30X/);
  assert.match(ana, /AI Second Brain/);
  assert.match(beto, /de EstadoX/);
  assert.match(beto, /IA para Abogados de EstadoX/);
});

// ─── Producto (programa) por evento ───────────────────────────────────────────

test('programKeyOf mapea los dos productos y null para desconocidos', () => {
  assert.equal(programKeyOf(SECOND_BRAIN_ET), 'second_brain');
  assert.equal(programKeyOf(ABOGADOS_ET), 'abogados');
  assert.equal(programKeyOf({ event_type: ABOGADOS_ET }), 'abogados'); // acepta el evento completo
  assert.equal(programKeyOf('https://api.calendly.com/event_types/otro'), null);
  assert.equal(programKeyOf(null), null);
});

test('eventJoinUrl saca el link de la llamada de location', () => {
  assert.equal(eventJoinUrl({ location: { type: 'zoom', join_url: 'https://zoom.us/j/123' } }), 'https://zoom.us/j/123');
  assert.equal(eventJoinUrl({ location: { type: 'custom', location: 'https://meet.example/x' } }), 'https://meet.example/x');
  assert.equal(eventJoinUrl({ location: { type: 'physical', location: 'Oficina' } }), 'Oficina');
  assert.equal(eventJoinUrl({}), '');
  assert.equal(eventJoinUrl(null), '');
});

// ─── Link wa.me (botón del closer al lead) ────────────────────────────────────

test('buildLeadLink normaliza el teléfono a dígitos y url-encodea el texto', () => {
  const link = buildLeadLink('+57 312 388 4238', 'Hola Ana, ¿cómo va?');
  assert.equal(link, 'https://wa.me/573123884238?text=Hola%20Ana%2C%20%C2%BFc%C3%B3mo%20va%3F');
  assert.equal(buildLeadLink(null, 'x'), null);
  assert.equal(buildLeadLink('', 'x'), null);
});

// ─── Copy precall por producto × push ─────────────────────────────────────────

test('buildPrecallText Push 1 distingue producto (intro + nombre del programa)', () => {
  const sb = buildPrecallText({ programKey: 'second_brain', pushN: 1, primerNombre: 'Ana', closer: 'Sebastian', hora: '3:00 p. m.' });
  assert.match(sb, /Hola Ana/);
  assert.match(sb, /Por acá Sebastian de Andrés Bilbao en 30X/);
  assert.match(sb, /AI Second Brain/);
  assert.match(sb, /a las 3:00 p\. m\./);
  assert.match(sb, /prender la cámara/);

  const ab = buildPrecallText({ programKey: 'abogados', pushN: 1, primerNombre: 'Ana', closer: 'Sebastian', hora: '3:00 p. m.' });
  assert.match(ab, /Por acá Sebastian de EstadoX/);
  assert.match(ab, /IA para Abogados de EstadoX/);
});

test('buildPrecallText Push 1 incrusta el bloque de materiales por producto', () => {
  // MATERIAL_LINKS está configurado (brochure HTML en GitHub Pages + video YouTube)
  // → el Push 1 incluye el bloque con el brochure y video del producto correcto.
  const sb = buildPrecallText({ programKey: 'second_brain', pushN: 1, primerNombre: 'Ana', closer: 'Sebastian', hora: '3pm' });
  assert.match(sb, /Es MUY IMPORTANTE que puedas ver estos materiales/);
  assert.match(sb, /juanito-brochures\/second-brain\.html/);
  assert.match(sb, /youtube\.com\/watch\?v=DSQ5_8OKonU/);

  const ab = buildPrecallText({ programKey: 'abogados', pushN: 1, primerNombre: 'Ana', closer: 'Sebastian', hora: '3pm' });
  assert.match(ab, /juanito-brochures\/ia-abogados\.html/);
  assert.match(ab, /youtube\.com\/watch\?v=88W1z_M9tCg/);
});

test('buildPrecallText Push 2 es igual entre productos (recordatorio corto)', () => {
  const sb = buildPrecallText({ programKey: 'second_brain', pushN: 2, primerNombre: 'Ana', closer: 'Sebastian', hora: '3pm' });
  const ab = buildPrecallText({ programKey: 'abogados', pushN: 2, primerNombre: 'Ana', closer: 'Sebastian', hora: '3pm' });
  assert.equal(sb, ab);
  assert.match(sb, /Buenos días Ana, feliz mañana/);
  assert.match(sb, /nos vemos hoy a las 3pm/);
});

test('buildPrecallText Push 3 incluye el link de la llamada cuando existe', () => {
  const con = buildPrecallText({ programKey: 'second_brain', pushN: 3, primerNombre: 'Ana', closer: 'Sebastian', hora: '3pm', linkLlamada: 'https://zoom.us/j/9' });
  assert.match(con, /Ya casi nos vemos Ana/);
  assert.match(con, /https:\/\/zoom\.us\/j\/9/);
  const sin = buildPrecallText({ programKey: 'second_brain', pushN: 3, primerNombre: 'Ana', closer: 'Sebastian', hora: '3pm' });
  assert.match(sin, /Ya casi nos vemos Ana/);
  assert.doesNotMatch(sin, /https/);
});

test('buildPush3Message incrusta el link wa.me con el push precall del lead', () => {
  const msg = buildPush3Message({
    name: 'Ana Gómez',
    firstName: 'Ana',
    phone: '+573001112222',
    startIso: '2026-06-10T20:30:00Z',
    programKey: 'abogados',
    closer: 'Sebastian',
    linkLlamada: 'https://zoom.us/j/9',
  });
  assert.match(msg, /Push 3/);
  assert.match(msg, /Ana Gómez/);
  assert.match(msg, /Enviar push: https:\/\/wa\.me\/573001112222\?text=/);
  // el texto encodeado es el push 3 precall (saludo + link de la llamada)
  const encoded = msg.split('?text=')[1];
  const decoded = decodeURIComponent(encoded);
  assert.match(decoded, /Ya casi nos vemos Ana/);
  assert.match(decoded, /zoom\.us\/j\/9/);
});

test('formatCallTime formatea en hora local', () => {
  const t = formatCallTime('2026-06-10T12:30:00Z'); // 07:30 en Bogota
  assert.match(t, /30/);
});
