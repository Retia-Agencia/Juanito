// scripts/calendly-day-check.js
// Diagnóstico: lista las citas de UN día y (opcional) de UN closer, tal como las
// devuelve la API de Calendly con la MISMA ventana [min,max) que usan los digests.
// Sirve para comprobar que el filtro por día no se "fuga" a citas de otros días.
//
// NO toca la DB ni envía WhatsApp. Solo lee Calendly. Requiere CALENDLY_TOKEN.
//
//   docker compose exec agent node scripts/calendly-day-check.js 2026-06-07 "sebastian.salazar@30x.com"
//   docker compose exec agent node scripts/calendly-day-check.js 2026-06-07            # todos los closers
//
// Args:
//   1) fecha objetivo  YYYY-MM-DD   (default: hoy en TZ)
//   2) filtro closer    email o nombre parcial (opcional)

import 'dotenv/config';
import {
  listProgramEvents,
  getFirstInvitee,
  firstNameFrom,
  closerEmailOf,
  prospectPhoneOf,
  formatCallTime,
  dayRangeUtc,
} from '../src/calendly/index.js';
import { resolveCloser } from '../src/calendly/closers.js';

if (!process.env.CALENDLY_TOKEN) {
  console.error('❌ Falta CALENDLY_TOKEN en el entorno (.env).');
  process.exit(1);
}

const TZ = process.env.TZ || 'America/Bogota';
const dateArg = process.argv[2];
const closerFilter = (process.argv[3] || '').toLowerCase().trim();

// Base = mediodía UTC del día pedido → evita cruces de frontera de día por el offset de TZ.
const base = dateArg ? new Date(`${dateArg}T12:00:00Z`) : new Date();
if (dateArg && Number.isNaN(base.getTime())) {
  console.error(`❌ Fecha inválida: "${dateArg}". Usa formato YYYY-MM-DD.`);
  process.exit(1);
}

const { minStartIso, maxStartIso } = dayRangeUtc(TZ, 0, base);

console.log(`\n🔎 Día objetivo: ${dateArg || '(hoy)'}  TZ=${TZ}`);
console.log(`   Ventana enviada a Calendly (UTC):`);
console.log(`     min_start_time = ${minStartIso}`);
console.log(`     max_start_time = ${maxStartIso}`);
if (closerFilter) console.log(`   Filtro closer: "${closerFilter}"`);
console.log('');

const events = await listProgramEvents({ minStartIso, maxStartIso });
console.log(`Calendly devolvió ${events.length} cita(s) de programa en esa ventana.\n`);

let mostradas = 0;
for (const ev of events) {
  const email = closerEmailOf(ev);
  const closer = resolveCloser(email);
  const closerName = closer?.name || `(sin mapear: ${email})`;

  if (closerFilter) {
    const hayMatch =
      (email && email.toLowerCase().includes(closerFilter)) ||
      closerName.toLowerCase().includes(closerFilter);
    if (!hayMatch) continue;
  }

  let invitee = null;
  try {
    invitee = await getFirstInvitee(ev.uri);
  } catch {
    /* sin invitee, igual listamos */
  }
  const prospecto = invitee?.name || '(sin invitee)';
  const phone = prospectPhoneOf(invitee) || 'sin teléfono';

  // Hora local + verificación de que el día coincide con el pedido
  const localDia = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ev.start_time));
  const okDia = !dateArg || localDia === dateArg ? '✅' : '⚠️ OTRO DÍA';

  mostradas++;
  console.log(
    `${okDia}  ${formatCallTime(ev.start_time, TZ)}  (${localDia})  | ${closerName}\n` +
      `        prospecto: ${firstNameFrom(prospecto)} — ${phone}\n` +
      `        start_time(UTC raw): ${ev.start_time}\n`
  );
}

console.log(`\nTotal mostradas: ${mostradas}${closerFilter ? ` (filtradas por "${closerFilter}")` : ''}`);
console.log('Si alguna línea sale con ⚠️ OTRO DÍA, el scoping por día tiene fuga.\n');
process.exit(0);
