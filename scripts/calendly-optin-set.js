// scripts/calendly-optin-set.js
// Backfill MANUAL de un opt-in de closer cuando la auto-captura falla (el closer
// SÍ le escribió a Juanito pero su LID no resolvió a teléfono y su pushName no
// matchea el nombre completo — caso Rodriguez/Pablo). Deja el opt-in en estado
// "ganado" (source='self') con su contact_jid real, que es lo único que habilita
// la entrega (ver deliver() en src/scheduler/calendly.js).
//
// ⚠️ Anti-ban: usar SOLO después de CONFIRMAR que ese closer realmente le escribió.
//    No sembrar a closers que no han iniciado conversación.
//
// El contact_jid es el JID desde el que escribió (visible en logs:
//   [Debug] fromMe=false rawJid=<...>@lid). Si el closer ya escribe con su número
//   normal puedes pasar ese mismo número como contact_jid.
//
//   docker compose exec agent node scripts/calendly-optin-set.js "<phoneOrName>" "<contact_jid>"
//
// Ejemplos:
//   docker compose exec agent node scripts/calendly-optin-set.js "Pablo Lozano" "254051828641894@lid"
//   docker compose exec agent node scripts/calendly-optin-set.js "+573046131437" "573046131437@s.whatsapp.net"

import 'dotenv/config';
import { resolveCloserByPhone, resolveCloserByPushName } from '../src/calendly/closers.js';
import { registerOptin, getOptin, setCloserPaused, isCloserPaused } from '../src/db/index.js';

const [idArg, contactJid] = process.argv.slice(2);

if (!idArg || !contactJid) {
  console.error('Uso: node scripts/calendly-optin-set.js "<phoneOrName>" "<contact_jid>"');
  console.error('Ej:  node scripts/calendly-optin-set.js "Pablo Lozano" "254051828641894@lid"');
  process.exit(1);
}

// Resolver el closer por número o por nombre (cualquiera de los dos).
const closer = resolveCloserByPhone(idArg) || resolveCloserByPushName(idArg);
if (!closer) {
  console.error(`✗ No reconozco a "${idArg}" como closer. Revisa el nombre/número en src/calendly/closers.js`);
  process.exit(1);
}

registerOptin({
  phone: closer.phone,
  closerEmail: closer.email,
  name: closer.name,
  source: 'self', // GANADO → habilita entrega (confirmado por el owner que escribió)
  contactJid,
});

// Backfill implica activar: si esa identidad estaba pausada, la despausamos. La pausa es por
// EMAIL/identidad (no por teléfono): despausamos la del closer resuelto.
setCloserPaused(closer.email, false);

const row = getOptin(closer.phone);
console.log(`\n✅ Opt-in actualizado para ${closer.name} (${closer.phone}):`);
console.log(`   source:      ${row.source}   ${row.source === 'self' ? '(habilita entrega)' : '⚠️ NO habilita'}`);
console.log(`   contact_jid: ${row.contact_jid || '⚠️ vacío (no entregará)'}`);
console.log(`   paused:      ${isCloserPaused(closer.email) ? 'sí' : 'no'}  (${closer.email})`);
console.log('');
process.exit(0);
