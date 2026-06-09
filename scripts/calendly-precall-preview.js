// scripts/calendly-precall-preview.js
// Vista previa de los pushes precall (template por producto + link wa.me), con
// datos de ejemplo. PURO: no toca red, DB ni WhatsApp → corre nativo en Windows.
//
//   node scripts/calendly-precall-preview.js
//
// Para PROBARLO en tu teléfono: copia un link "https://wa.me/...?text=..." de la
// salida y ábrelo en WhatsApp. Debería abrir el chat de ESE número con el mensaje
// precall ya escrito (solo faltaría darle enviar). Cambia DEMO.leadPhone abajo por
// tu propio número (con código de país) para que el chat sea contigo.

import {
  buildDigestMessage,
  buildPush3Message,
  MATERIAL_LINKS,
} from '../src/calendly/index.js';

process.env.TZ = process.env.TZ || 'America/Bogota';

const DEMO = {
  closer: 'Sebastián', // primer nombre del closer
  leadName: 'Ana Gómez',
  leadFirst: 'Ana',
  leadPhone: '+57 300 111 2222', // ← cámbialo por TU número para probar en tu cel
  startIso: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
  joinUrl: 'https://us02web.zoom.us/j/EJEMPLO',
};

const PRODUCTS = [
  { key: 'second_brain', name: 'AI Second Brain 30X' },
  { key: 'abogados', name: 'Programa IA para Abogados | EstadoX' },
];

function hr(t) {
  console.log(`\n${'═'.repeat(72)}\n  ${t}\n${'═'.repeat(72)}`);
}

const linksFaltan = Object.values(MATERIAL_LINKS).every((p) => !p.brochure && !p.video);
if (linksFaltan) {
  console.log(
    '\n⚠️  MATERIAL_LINKS está vacío (brochure/video) → el bloque de materiales del\n' +
      '   Push 1 se omite. Cuando el owner entregue los links, edítalos en\n' +
      '   src/calendly/index.js (MATERIAL_LINKS) y este Push 1 los incluirá.'
  );
}

for (const prod of PRODUCTS) {
  hr(`PRODUCTO: ${prod.name}`);

  // Push 1 y Push 2 son digests (lista de leads). Mostramos uno con 1 lead.
  const item = {
    name: DEMO.leadName,
    firstName: DEMO.leadFirst,
    phone: DEMO.leadPhone,
    startIso: DEMO.startIso,
    programKey: prod.key,
  };

  console.log('\n── PUSH 1 (7pm día anterior — digest) ' + '─'.repeat(30));
  console.log(
    buildDigestMessage({
      pushLabel: 'Push 1 (la noche anterior)',
      whenLabel: 'mañana',
      items: [item],
      pushN: 1,
      closer: DEMO.closer,
    })
  );

  console.log('\n── PUSH 2 (6:30am mismo día — digest) ' + '─'.repeat(30));
  console.log(
    buildDigestMessage({
      pushLabel: 'Push 2 (en la mañana)',
      whenLabel: 'hoy',
      items: [item],
      pushN: 2,
      closer: DEMO.closer,
    })
  );

  console.log('\n── PUSH 3 (25min antes — por llamada) ' + '─'.repeat(30));
  console.log(
    buildPush3Message({
      name: DEMO.leadName,
      firstName: DEMO.leadFirst,
      phone: DEMO.leadPhone,
      startIso: DEMO.startIso,
      programKey: prod.key,
      closer: DEMO.closer,
      linkLlamada: DEMO.joinUrl,
    })
  );
}

console.log(`\n${'═'.repeat(72)}`);
console.log('  Copia un link wa.me de arriba y ábrelo en WhatsApp para ver el mensaje');
console.log('  precall ya escrito. (Cambia DEMO.leadPhone por tu número para probar.)');
console.log('═'.repeat(72) + '\n');
