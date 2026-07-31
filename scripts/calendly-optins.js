// scripts/calendly-optins.js
// Lista los closers que ya hicieron opt-in (le escribieron a Juanito).
// Útil para ver quién falta antes de activar el envío real.
//
//   docker compose exec agent node scripts/calendly-optins.js

import 'dotenv/config';
import { listOptins } from '../src/db/index.js';
import { CLOSERS, workLidForCloser, isNonCanonicalOptinJid } from '../src/calendly/closers.js';
import { normalizePhone } from '../src/common/utils.js';

const registrados = listOptins();
const regSet = new Set(registrados.map((r) => r.phone));

console.log(`\nClosers registrados (${registrados.length}):`);
for (const r of registrados) {
  console.log(`  ✅ ${r.name || r.closer_email || '?'}  (${r.phone})  — ${r.registered_at}`);
}

const faltantes = Object.entries(CLOSERS).filter(
  ([, c]) => ![...regSet].some((p) => c.phone.replace(/\D/g, '').endsWith(p) || p.endsWith(c.phone.replace(/\D/g, '')))
);

console.log(`\nFaltan por escribirle a Juanito (${faltantes.length}):`);
for (const [email, c] of faltantes) {
  console.log(`  ⏳ ${c.name}  (${c.phone})  — ${email}`);
}

// ─── Coherencia código ↔ DB: ¿los pushes van a donde creemos? ──────────────────
// El invariante NO se puede probar con un test unitario: compara el roster (código) contra
// `calendly_optins` (datos de producción). Acá es donde tiene sentido, corriendo contra la DB
// viva. Es la comprobación que faltaba cuando el bug de Pablo Suarez (§18.AJ) pasó una semana
// mandándole los pushes al aparato viejo con los logs en verde.
// Indexado por TELÉFONO, no por email: `calendly_optins.phone` es la PK y es la llave con la que
// `deliver()` busca la fila. Dos identidades de la misma persona en una sola línea (Salazar: 30x
// + retia) COMPARTEN fila a propósito, y buscar por email haría ver una de ellas como "sin
// opt-in" cuando está perfecta.
const porTelefono = new Map(registrados.map((r) => [normalizePhone(r.phone), r]));

console.log('\nCoherencia del destino de entrega:');
let desajustes = 0;
for (const [email, c] of Object.entries(CLOSERS)) {
  const o = porTelefono.get(normalizePhone(c.phone));
  const esperado = workLidForCloser(email);
  if (!o) {
    console.log(`  ⏳ ${c.name} — sin opt-in (${email})`);
  } else if (!o.contact_jid) {
    // Estado deliberado tras rotar de número: no se entrega nada hasta que escriba desde la
    // línea nueva. Es ruidoso a propósito (mejor que entregar callado al aparato viejo).
    console.log(`  ⏳ ${c.name} — ESPERANDO que escriba desde ${c.phone} (contact_jid en NULL tras rotar)`);
  } else if (esperado && o.contact_jid !== esperado) {
    console.log(`  ❌ ${c.name} — DESAJUSTE: se declaró ${esperado} pero el opt-in entrega a ${o.contact_jid}`);
    desajustes++;
  } else if (esperado) {
    console.log(`  ✅ ${c.name} — hilo fijado y verificado (${esperado})`);
  } else if (isNonCanonicalOptinJid(c.phone, o.contact_jid)) {
    console.log(`  ❌ ${c.name} — el opt-in entrega a un número distinto al canónico: ${o.contact_jid}`);
    desajustes++;
  } else {
    // Un @lid sin workLid declarado no se puede contrastar contra nada.
    console.log(`  ⚠️  ${c.name} — SIN VERIFICAR: ${o.contact_jid} es opaco y no hay workLid declarado`);
  }
}
console.log(desajustes ? `\n❌ ${desajustes} desajuste(s)` : '\n✅ sin desajustes');
console.log('');
process.exit(desajustes ? 1 : 0);
