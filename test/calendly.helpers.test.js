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
  MATERIAL_LINKS,
  PROGRAM_EVENT_TYPES,
} = await import('../src/calendly/index.js');

const SECOND_BRAIN_ET = 'https://api.calendly.com/event_types/56efc028-ee2f-46e8-852c-e50d45b15b83';
// Mudado 2026-08-25 al Calendly propio de EstadoX (el viejo era f8d123ac-…, de la conexión 30x).
const ABOGADOS_ET = 'https://api.calendly.com/event_types/83bb87b3-0c73-43ea-a618-196a74512eab';
const LINKEDIN_ET = 'https://api.calendly.com/event_types/96ddf036-9174-459c-be73-b248ad95be13';
const DEVELOPERS_ET = 'https://api.calendly.com/event_types/dff3e48a-4859-417a-98fb-822048aef5d9';
const OPERACIONES_ET = 'https://api.calendly.com/event_types/8462e92a-8210-4bb2-8e2b-583aa3c3d877';
const INSTAGRAM_ET = 'https://api.calendly.com/event_types/d33075cb-d349-43ef-be43-6f80f9c5da03';
const { resolveCloser, resolveCloserByPhone, resolveCloserByLid, resolveCloserByPushName, isNonCanonicalOptinJid, isIgnoredCloser, workLidForCloser, extraJidsForCloser } = await import('../src/calendly/closers.js');

// Encabezado del bloque de materiales, literal. Se repite acá a propósito (no se importa): si
// alguien cambia el copy en index.js, este test tiene que fallar y obligar a decidirlo.
const MATERIALS_HEADER_TXT = 'Es MUY IMPORTANTE que puedas ver estos materiales sí o sí antes de nuestra llamada:';

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

// Segunda fuente (2026-08-26): Retia y ComunicArte pusieron el teléfono como PREGUNTA del
// formulario y dejaron la casilla nativa apagada. Los dos textos de abajo son los reales de
// producción, typo incluido — por eso el match va normalizado y no por string exacto.
test('prospectPhoneOf cae a questions_and_answers cuando no hay text_reminder_number', () => {
  const retia = {
    text_reminder_number: null,
    questions_and_answers: [{ question: 'Ingrese su número telefonico:', answer: '+57 316 3428340' }],
  };
  const comunicarte = {
    text_reminder_number: null,
    questions_and_answers: [{ question: 'Ingrese su número telefónico', answer: '+57 315 4995203' }],
  };
  assert.equal(prospectPhoneOf(retia), '+57 316 3428340');
  assert.equal(prospectPhoneOf(comunicarte), '+57 315 4995203');
});

test('prospectPhoneOf prefiere text_reminder_number sobre la pregunta', () => {
  const inv = {
    text_reminder_number: '+57 310 4130771',
    questions_and_answers: [{ question: 'Ingrese su número telefonico:', answer: '+57 999 9999999' }],
  };
  assert.equal(prospectPhoneOf(inv), '+57 310 4130771');
});

test('prospectPhoneOf ignora respuestas numéricas de preguntas que NO son de teléfono', () => {
  // El caso que hace daño: un link wa.me hacia una cifra de facturación.
  const inv = {
    text_reminder_number: null,
    questions_and_answers: [{ question: '¿Cuánto facturas al mes?', answer: '8000000' }],
  };
  assert.equal(prospectPhoneOf(inv), null);
});

test('prospectPhoneOf ignora respuestas de texto libre a una pregunta de teléfono', () => {
  const inv = {
    text_reminder_number: null,
    questions_and_answers: [
      { question: 'Please share anything that will help prepare for our meeting.', answer: 'Vendo licores' },
      { question: 'Tu WhatsApp', answer: 'el mismo del correo' },
      { question: 'Celular', answer: '123' }, // muy corto para ser marcable
    ],
  };
  assert.equal(prospectPhoneOf(inv), null);
});

test('resolveCloser mapea closers por email (case-insensitive)', () => {
  assert.equal(resolveCloser('sebastian.salazar@30x.com').phone, '+573054312905');
  assert.equal(resolveCloser('SEBASTIAN.MARIN@30x.com').phone, '+573170623894'); // case-insensitive · rotado 2026-07-30
  assert.equal(resolveCloser('lucas.mendoza@30x.com').name, 'Lucas Mendoza');
  assert.equal(resolveCloser('mateo.leon@30x.com'), null);      // salió del equipo
  assert.equal(resolveCloser('equipo@estadox.com'), null);      // EstadoX en standby
  assert.equal(resolveCloser('desconocido@x.com'), null);
  assert.equal(resolveCloser(null), null);
});

test('resolveCloserByPhone identifica al closer por su número entrante', () => {
  // con sufijo de WhatsApp y formato distinto
  assert.equal(resolveCloserByPhone('573054312905@s.whatsapp.net').email, 'sebastian.salazar@30x.com');
  assert.equal(resolveCloserByPhone('+57 301 809 4666').name, 'Daniela Camacho'); // rotado 2026-07-28
  assert.equal(resolveCloserByPhone('573103062287'), null);                       // número viejo → ya no resuelve
  assert.equal(resolveCloserByPhone('573170623894').email, 'sebastian.marin@30x.com'); // rotado 2026-07-30
  assert.equal(resolveCloserByPhone('573212100048'), null);                       // número viejo → ya no resuelve
  assert.equal(resolveCloserByPhone('573014477044').name, 'Lucas Mendoza');
  assert.equal(resolveCloserByPhone('573003558574'), null); // Mateo salió → ya no resuelve
  assert.equal(resolveCloserByPhone('573999999999'), null);
  assert.equal(resolveCloserByPhone(''), null);
});

test('resolveCloserByPushName resuelve por nombre completo e ignora ambigüedades', () => {
  // Nombres exactos
  assert.equal(resolveCloserByPushName('Pablo Lozano').email, 'pablo.lozano@30x.com');
  assert.equal(resolveCloserByPushName('Lucas Mendoza').email, 'lucas.mendoza@30x.com');
  // Case insensitive y con emojis
  assert.equal(resolveCloserByPushName('pablo lozano 📞').phone, '+573046131437');
  // Varios Sebastians — "Sebastian" solo es ambiguo → null
  assert.equal(resolveCloserByPushName('Sebastian'), null);
  // Con apellido → resuelve unívocamente...
  assert.equal(resolveCloserByPushName('Sebastian Salazar').email, 'sebastian.salazar@30x.com');
  assert.equal(resolveCloserByPushName('Sebastian Marin').email, 'sebastian.marin@30x.com');
  // ...EXCEPTO "Sebastian Rodriguez": MISMA persona, dos programas → dos entradas (sebastian@30x.com
  // [30x] y sebasrr321@gmail.com [retia]) → ambiguo → null (entra por teléfono/LID, no por nombre).
  assert.equal(resolveCloserByPushName('Sebastian Rodriguez'), null);
  // Mateo salió → ya no se reconoce
  assert.equal(resolveCloserByPushName('Mateo Leon'), null);
  // No reconocido → null
  assert.equal(resolveCloserByPushName('Juan Desconocido'), null);
  assert.equal(resolveCloserByPushName(''), null);
  assert.equal(resolveCloserByPushName(null), null);
});

// isNonCanonicalOptinJid — detecta el bug "pushes al número personal" (Sebas): el closer se
// registró desde un número distinto al de trabajo, así que el contact_jid apunta al equivocado.
// resolveCloserByLid — reconoce closers por su LID de trabajo conocido (CLOSER_LIDS), para cuentas
// cuyo @lid no mapea al teléfono y cuyo pushName no permite el match (ej: Sebas Rodriguez).
test('resolveCloserByLid: LID de trabajo conocido → resuelve al closer', () => {
  assert.equal(resolveCloserByLid('158025419608301@lid').email, 'sebastian@30x.com');
  assert.equal(resolveCloserByLid('158025419608301@lid').name, 'Sebastian Rodriguez');
  // acepta también solo los dígitos del LID
  assert.equal(resolveCloserByLid('158025419608301').email, 'sebastian@30x.com');
});

// Sebastian Rodriguez tiene DOS identidades reales (una por conexión, cada una en su propio
// número): 30x (158025419608301@lid) y retia (20671711162446@lid). Confirmado 2026-07-21.
test('resolveCloserByLid: identidad de retia (segundo LID de la misma persona) → resuelve', () => {
  assert.equal(resolveCloserByLid('20671711162446@lid').email, 'sebasrr321@gmail.com');
  assert.equal(resolveCloserByLid('20671711162446@lid').name, 'Sebastian Rodriguez');
});

test('resolveCloserByLid: LID desconocido / vacío → null', () => {
  assert.equal(resolveCloserByLid('999999999@lid'), null);
  assert.equal(resolveCloserByLid(''), null);
  assert.equal(resolveCloserByLid(null), null);
});

// workLidForCloser — PIN del contact_jid al LID de trabajo. Mata el bug recurrente de "pushes
// al personal": cuando Sebas escribe desde su personal (pushName "Sebastian Rodriguez" matchea y
// haría driftear el contact_jid), la entrega se queda pinneada a su LID de trabajo.
test('workLidForCloser: closer mapeado en CLOSER_LIDS → devuelve su LID de trabajo', () => {
  assert.equal(workLidForCloser('sebastian@30x.com'), '158025419608301@lid');
  assert.equal(workLidForCloser('SEBASTIAN@30X.COM'), '158025419608301@lid'); // case-insensitive
});

test('workLidForCloser: closer sin LID mapeado / vacío → null', () => {
  // Retia no declara workLid (no recibe Push 4, así que no hay entrega probada que copiar).
  assert.equal(workLidForCloser('registro@ttrading.co'), null);
  assert.equal(workLidForCloser('desconocido@30x.com'), null);
  assert.equal(workLidForCloser(''), null);
  assert.equal(workLidForCloser(null), null);
});

// Marín cerró su rotación de línea (2026-07-30 → contact_jid 47657695375437@lid, verificado en
// producción) y desde el 2026-08-04 recibe COPIA en su línea vieja. Las dos mitades del contrato:
test('workLidForCloser devuelve el LID de TRABAJO, nunca el del aparato secundario', () => {
  // Si devolviera el extra, el opt-in pinnearía la entrega primaria al aparato viejo
  // (`contactJid = workJid || from`) y la "copia" se habría convertido en el destino.
  assert.equal(workLidForCloser('sebastian.marin@30x.com'), '47657695375437@lid');
});

test('extraJidsForCloser: solo los aparatos secundarios declarados, y vacío para el resto', () => {
  assert.deepEqual(extraJidsForCloser('sebastian.marin@30x.com'), ['248489795702847@lid']);
  assert.deepEqual(extraJidsForCloser('SEBASTIAN.MARIN@30X.COM'), ['248489795702847@lid']);
  // El caso normal del roster: sin copia. Un `[]` acá es lo que hace que deliver() no cambie
  // de comportamiento para los otros ocho closers.
  assert.deepEqual(extraJidsForCloser('pablo.lozano@30x.com'), []);
  assert.deepEqual(extraJidsForCloser('desconocido@30x.com'), []);
  assert.deepEqual(extraJidsForCloser(''), []);
  assert.deepEqual(extraJidsForCloser(null), []);
});

test('resolveCloserByLid reconoce también el aparato SECUNDARIO', () => {
  // Si escribe desde la línea vieja y no lo reconociéramos, sería un desconocido: sin rol de
  // closer, sin setteo y sin poder contestar un Push 4 que él mismo acaba de recibir ahí.
  assert.equal(resolveCloserByLid('248489795702847@lid')?.email, 'sebastian.marin@30x.com');
});

test('isNonCanonicalOptinJid: número de trabajo (coincide) → false', () => {
  const trabajo = '+573102212005'; // Sebastian Rodriguez (canónico)
  assert.equal(isNonCanonicalOptinJid(trabajo, '573102212005@s.whatsapp.net'), false);
  assert.equal(isNonCanonicalOptinJid(trabajo, '+57 310 221 2005'), false);
});

test('isNonCanonicalOptinJid: número de TELÉFONO distinto al canónico → true (el bug)', () => {
  const trabajo = '+573102212005';
  assert.equal(isNonCanonicalOptinJid(trabajo, '573009998877@s.whatsapp.net'), true);
});

test('isNonCanonicalOptinJid: @lid opaco (multi-device) → false (no se puede juzgar)', () => {
  const trabajo = '+573102212005';
  assert.equal(isNonCanonicalOptinJid(trabajo, '158025419608301@lid'), false);
});

test('isNonCanonicalOptinJid: entradas vacías → false (no alarmar sin datos)', () => {
  assert.equal(isNonCanonicalOptinJid('', '573009998877@s.whatsapp.net'), false);
  assert.equal(isNonCanonicalOptinJid('+573102212005', ''), false);
  assert.equal(isNonCanonicalOptinJid(null, null), false);
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

test('programKeyOf mapea los cinco productos y null para desconocidos', () => {
  assert.equal(programKeyOf(SECOND_BRAIN_ET), 'second_brain');
  assert.equal(programKeyOf(ABOGADOS_ET), 'abogados');
  assert.equal(programKeyOf(LINKEDIN_ET), 'linkedin');
  assert.equal(programKeyOf(DEVELOPERS_ET), 'developers');
  assert.equal(programKeyOf(OPERACIONES_ET), 'operaciones');
  assert.equal(programKeyOf({ event_type: LINKEDIN_ET }), 'linkedin'); // acepta el evento completo
  assert.equal(programKeyOf('https://api.calendly.com/event_types/otro'), null);
  assert.equal(programKeyOf(null), null);
});

// Los event_types cableados y el copy tienen que ir de la mano. Sin esta guarda, agregar un
// programa a PROGRAM_EVENT_TYPES sin su copy hace que sus closers no reciban push (o, antes
// del endurecimiento, que el lead recibiera el pitch del programa equivocado).
test('todo programa cableado tiene copy y brochure propios', () => {
  for (const et of PROGRAM_EVENT_TYPES()) {
    const key = programKeyOf(et);
    assert.ok(key, `event_type sin clave de programa: ${et}`);
    const push1 = buildPrecallText({ programKey: key, pushN: 1, primerNombre: 'Ana', closer: 'Sebastian', hora: '3pm' });
    assert.ok(push1, `${key}: no tiene copy en PROGRAM_PITCH`);
    // Todo programa DECLARA su brochure, aunque no lo mande: el registro es la fuente de verdad
    // del material del programa, y `sendLinks:false` (operaciones) solo decide si viaja en el
    // push. Si algún día se reactiva, el link ya está donde tiene que estar.
    assert.ok(MATERIAL_LINKS[key]?.brochure, `${key}: no declara brochure`);
    // Los que SÍ mandan links lo hacen por LINK dentro del copy: abre renderizado en el celular
    // del lead y no depende de que el closer reenvíe un PDF.
    if (MATERIAL_LINKS[key].sendLinks !== false) {
      assert.ok(push1.includes(MATERIAL_LINKS[key].brochure), `${key}: no entrega brochure por link`);
    }
  }
});

test('los programas nuevos nombran SU programa, no el de otro', () => {
  const dev = buildPrecallText({ programKey: 'developers', pushN: 1, primerNombre: 'Ana', closer: 'Pablo', hora: '3pm' });
  assert.match(dev, /programa de AI for Developers de 30X/);
  assert.ok(!dev.includes('Second Brain'), 'no debe colarse el pitch de Second Brain');
  assert.ok(!dev.includes('🎥'), 'todavía no tiene video → sin la línea de video');

  // Copy propio de operaciones (2026-07-28): sin "de" delante, sin "de 30X" al final y con "IA",
  // no "AI". Es el ÚNICO programa cuyo nombre no termina en la marca.
  const ops = buildPrecallText({ programKey: 'operaciones', pushN: 1, primerNombre: 'Ana', closer: 'Lucas', hora: '3pm' });
  assert.match(ops, /postulación al programa Operaciones Escalables con IA\./);
  assert.ok(!ops.includes('con AI'), 'operaciones: el programa se llama "con IA", no "con AI"');
});

// Operaciones Escalables es la ÚNICA excepción a "el material viaja en el push" (jefe,
// 2026-07-28): el brochure sigue declarado en PROGRAMS pero el closer lo entrega por su cuenta.
// El encabezado se queda —en negrita— aunque no lo siga ningún link. Sin este test, un refactor
// de materialsBlock puede "arreglar" el encabezado huérfano borrándolo, o recuperar el link.
test('operaciones: encabezado de materiales en negrita y SIN links; el resto no se entera', () => {
  const ops = buildPrecallText({ programKey: 'operaciones', pushN: 1, primerNombre: 'Ana', closer: 'Lucas', hora: '3pm' });
  assert.match(ops, /\*Es MUY IMPORTANTE que puedas ver estos materiales sí o sí antes de nuestra llamada:\*/);
  assert.ok(!ops.includes(MATERIAL_LINKS.operaciones.brochure), 'operaciones: el brochure NO debe viajar en el push');
  assert.ok(!ops.includes('📄'), 'operaciones: sin línea de brochure');
  assert.ok(!ops.includes('🎥'), 'operaciones: sin línea de video');
  assert.ok(ops.trimEnd().endsWith(':*'), 'el encabezado en negrita cierra el mensaje');

  // El flag es por-programa: los demás siguen con encabezado SIN negrita y CON sus links.
  for (const prog of Object.keys(MATERIAL_LINKS)) {
    if (prog === 'operaciones') continue;
    const txt = buildPrecallText({ programKey: prog, pushN: 1, primerNombre: 'Ana', closer: 'Sebastian', hora: '3pm' });
    assert.ok(txt.includes(`\n${MATERIALS_HEADER_TXT}\n`), `${prog}: el encabezado no debe llevar negrita`);
    assert.ok(!txt.includes(`*${MATERIALS_HEADER_TXT}*`), `${prog}: se le coló la negrita de operaciones`);
  }
});

test('isIgnoredCloser: hosts conocidos no gestionados → true; mapeados/desconocidos → false', () => {
  assert.equal(isIgnoredCloser('andrea.machado@30x.com'), true);
  assert.equal(isIgnoredCloser('DANA@30x.com'), true); // case-insensitive
  assert.equal(isIgnoredCloser('mateo.leon@30x.com'), true); // salió → se ignora en silencio
  assert.equal(isIgnoredCloser('sebastian.marin@30x.com'), false); // closer activo de LinkedIn
  assert.equal(isIgnoredCloser('desconocido@x.com'), false);
  assert.equal(isIgnoredCloser(null), false);
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

// Se asserta contra MATERIAL_LINKS, NO contra los links literales: el owner cambia los
// decks cada tanto (p.ej. el de Second Brain en 2e8e109) y hardcodearlos acá hacía que el
// test se pudriera en cada cambio de copy. Lo que importa es que el bloque LLEVE el link
// configurado del producto correcto, no cuál es ese link.
test('buildPrecallText Push 1 incrusta el bloque de materiales del producto correcto', () => {
  for (const prog of Object.keys(MATERIAL_LINKS)) {
    const txt = buildPrecallText({ programKey: prog, pushN: 1, primerNombre: 'Ana', closer: 'Sebastian', hora: '3pm' });
    // El encabezado va SIEMPRE, mande links o no (operaciones lo conserva con `sendLinks:false`).
    assert.match(txt, /Es MUY IMPORTANTE que puedas ver estos materiales/);
    // Brochure y video son AMBOS opcionales, pero si el programa declara uno, tiene que viajar en
    // el copy. developers/operaciones lanzaron con solo brochure; tactical_investor con solo video
    // (deck PDF pendiente). El link va dentro del copy — el lead lo abre sin depender de reenvíos.
    // Excepción: `sendLinks:false` (operaciones) declara sus links pero no los manda — su test
    // propio cubre ese caso, acá solo lo saltamos.
    if (MATERIAL_LINKS[prog].sendLinks === false) continue;
    if (MATERIAL_LINKS[prog].brochure) assert.ok(txt.includes(MATERIAL_LINKS[prog].brochure), `${prog}: falta su brochure`);
    if (MATERIAL_LINKS[prog].video) assert.ok(txt.includes(MATERIAL_LINKS[prog].video), `${prog}: falta su video`);
  }

  // Y que no se cruce el material entre productos: el de abogados no lleva el de LinkedIn.
  const ab = buildPrecallText({ programKey: 'abogados', pushN: 1, primerNombre: 'Ana', closer: 'Sebastian', hora: '3pm' });
  assert.ok(!ab.includes(MATERIAL_LINKS.linkedin.brochure));

  // LinkedIn Sales: intro "de 30X" + nombre del programa.
  const li = buildPrecallText({ programKey: 'linkedin', pushN: 1, primerNombre: 'Ana', closer: 'Sebastian', hora: '3pm' });
  assert.match(li, /Por acá Sebastian de 30X/);
  assert.match(li, /programa de LinkedIn Sales de 30X/);
});

// Instagram & TikTok (2026-07-16): su ET es tipo pool y se resolvió desde las reservas
// reales. Si se cae de PROGRAM_EVENT_TYPES, el bot deja de ver sus llamadas EN SILENCIO.
test('Instagram & TikTok está en la lista de programas y enruta a su copy', () => {
  assert.ok(PROGRAM_EVENT_TYPES().includes(INSTAGRAM_ET), 'el ET de Instagram no está en PROGRAM_EVENT_TYPES');
  assert.equal(programKeyOf(INSTAGRAM_ET), 'instagram');
  assert.equal(programKeyOf({ event_type: INSTAGRAM_ET }), 'instagram');

  const ig = buildPrecallText({ programKey: 'instagram', pushN: 1, primerNombre: 'Ana', closer: 'Sebastian', hora: '3pm' });
  assert.match(ig, /Por acá Sebastian de 30X/);
  assert.match(ig, /programa de Instagram & TikTok for Business de 30X/);
  assert.ok(ig.includes(MATERIAL_LINKS.instagram.brochure));
  assert.ok(ig.includes(MATERIAL_LINKS.instagram.video));
});

// Guarda del endurecimiento: un programa sin copy en PROGRAM_PITCH NO debe fabricar un
// mensaje con el pitch de otro programa (antes caía a second_brain). El texto viaja en el
// link wa.me que el closer toca para enviar, así que un pitch errado le llega al lead.
test('buildPrecallText devuelve null si el programa no tiene copy (no inventa otro)', () => {
  assert.equal(buildPrecallText({ programKey: 'programa_nuevo', pushN: 1, primerNombre: 'Ana', closer: 'Sebastian', hora: '3pm' }), null);
  assert.equal(buildLeadLink('+573001234567', null), null); // y sin texto no se arma link
});

test('buildPush3Message sin copy del programa degrada a manual, no manda link roto', () => {
  const msg = buildPush3Message({
    name: 'Ana Gómez', phone: '+573001234567',
    startIso: '2026-07-15T20:00:00.000Z', programKey: 'programa_nuevo', closer: 'Sebastian',
  });
  assert.match(msg, /mándalo manual/);
  assert.ok(!msg.includes('wa.me'), 'no debe incluir un link wa.me con texto "null"');
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
