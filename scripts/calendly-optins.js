// scripts/calendly-optins.js
// Lista los closers que ya hicieron opt-in (le escribieron a Juanito).
// Útil para ver quién falta antes de activar el envío real.
//
//   docker compose exec agent node scripts/calendly-optins.js

import 'dotenv/config';
import { listOptins } from '../src/db/index.js';
import { CLOSERS } from '../src/calendly/closers.js';

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
console.log('');
process.exit(0);
