// scripts/calendly-dryrun.js
// Ejecuta UNA pasada de la lógica de Calendly en modo dry-run, sin arrancar los
// crons ni enviar WhatsApp. Sirve para validar contra citas reales.
//
// Requiere CALENDLY_TOKEN en el entorno. Correr en el VPS (better-sqlite3 no
// compila en Windows):
//   docker compose exec agent node scripts/calendly-dryrun.js
//
// Antes, asegurarse de haber migrado la DB:  npm run migrate

import 'dotenv/config';

// Forzar dry-run pase lo que pase
process.env.CALENDLY_DRY_RUN = 'true';

if (!process.env.CALENDLY_TOKEN) {
  console.error('❌ Falta CALENDLY_TOKEN en el entorno (.env).');
  process.exit(1);
}

const { runCalendlyPoll, runPush1, runPush2, runCalendlyDelivery } = await import(
  '../src/scheduler/calendly.js'
);

console.log('\n========== POLL — agenda Push 3 (25 min antes) ==========');
await runCalendlyPoll();

console.log('\n========== PUSH 1 — digest de MAÑANA (7:00pm) ==========');
await runPush1();

console.log('\n========== PUSH 2 — digest de HOY (6:30am) ==========');
await runPush2();

console.log('\n========== ENTREGA — Push 3 ya vencidos (dry-run) ==========');
await runCalendlyDelivery();

console.log('\n✅ Pasada dry-run completa. Nada se envió por WhatsApp.\n');
process.exit(0);
