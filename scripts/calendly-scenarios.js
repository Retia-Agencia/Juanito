// scripts/calendly-scenarios.js
// "Dry-run determinista": imprime, escenario por escenario, qué haría el sistema
// de pushes precall ante situaciones que el dry-run en vivo NO puede forzar
// (reservas tardías, reagendas tras envío, concurrencia, sin opt-in, alertas).
//
// A diferencia de scripts/calendly-dryrun.js (pega al Calendly REAL y solo muestra
// lo que haya hoy), este NO toca red ni DB ni WhatsApp: usa el harness de
// test/helpers. Corre en cualquier máquina, sin token ni better-sqlite3:
//
//   node scripts/calendly-scenarios.js
//
// Útil para ENTENDER el comportamiento; las aserciones formales viven en
// test/calendly.scenarios.test.js.

process.env.TZ = process.env.TZ || 'America/Bogota';
process.env.CALENDLY_DRY_RUN = 'false';     // queremos VER los envíos simulados
process.env.CALENDLY_REQUIRE_OPTIN = 'true';
process.env.CALENDLY_PUSH3_LEAD_MIN = '25';
process.env.ADMIN_LID = '129446371655733@lid';

const scheduler = await import('../src/scheduler/calendly.js');
const { __resetHealth, getHealth } = await import('../src/calendly/health.js');
const { installHarness, makeEvent } = await import('../test/helpers/calendly-harness.js');

const MIN = 60000;
const SALAZAR = 'sebastian.salazar@30x.com';
const SALAZAR_PHONE = '+573054312905';

// Silenciar los console.log internos del scheduler para que el reporte quede limpio.
const realLog = console.log;
const realWarn = console.warn;
const realErr = console.error;
function quiet() {
  console.log = console.warn = console.error = () => {};
}
function loud() {
  console.log = realLog;
  console.warn = realWarn;
  console.error = realErr;
}

function banner(n, title) {
  loud();
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  ESCENARIO ${n}: ${title}`);
  console.log('═'.repeat(72));
}
function line(label, value) {
  console.log(`   ${label.padEnd(34)} ${value}`);
}
function showSends(wa) {
  if (!wa.sent.length) {
    console.log('   📭 (nada enviado)');
    return;
  }
  for (const m of wa.sent) {
    const first = m.text.split('\n')[0];
    console.log(`   📨 → ${m.to}`);
    console.log(`        ${first}`);
  }
}

async function run() {
  const now = Date.now();

  // 1 — Catch-up de reserva tardía (decisión 4b)
  banner(1, 'Reserva tardía: llamada en 20 min (los 3 triggers normales ya pasaron)');
  {
    __resetHealth(); scheduler.__resetDeps();
    quiet();
    const events = [makeEvent({ uuid: 'late', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
    const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: now });
    await scheduler.runCalendlyPoll();
    await scheduler.runCalendlyDelivery();
    loud();
    line('Pushes agendados:', h.store._rows.length);
    line('Estado final del push:', h.store._rows[0]?.status);
    console.log('   Resultado:');
    showSends(h.wa);
    console.log('   → Antes del fix: 0 pushes (se descartaba). Ahora: catch-up inmediato.');
  }

  // 2 — Reagenda DESPUÉS de enviado el Push 3 (bug #2)
  banner(2, 'Reagenda después de que el Push 3 YA se envió');
  {
    __resetHealth(); scheduler.__resetDeps();
    quiet();
    const events = [makeEvent({ uuid: 'rs', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
    const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: now });
    await scheduler.runCalendlyPoll();
    await scheduler.runCalendlyDelivery();        // se envía (1)
    h.api.reschedule('rs', new Date(now + 90 * MIN).toISOString());
    h.clock.ms = now + 30 * MIN;
    await scheduler.runCalendlyPoll();            // re-arma
    h.clock.ms = now + 90 * MIN - 25 * MIN + MIN; // llega la nueva hora
    await scheduler.runCalendlyDelivery();        // se envía (2)
    loud();
    line('Envíos totales:', h.wa.sent.length);
    line('Estado final:', h.store._rows[0]?.status);
    console.log('   → Antes del fix: 1 envío (el closer nunca sabía la nueva hora). Ahora: 2.');
  }

  // 3 — Doble envío por concurrencia (bug #1)
  banner(3, 'Dos entregas concurrentes (cron solapado)');
  {
    __resetHealth(); scheduler.__resetDeps();
    quiet();
    const events = [makeEvent({ uuid: 'dup', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
    const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: now });
    await scheduler.runCalendlyPoll();
    await Promise.all([scheduler.runCalendlyDelivery(), scheduler.runCalendlyDelivery()]);
    loud();
    line('Envíos (debe ser 1):', h.wa.sent.length);
    console.log('   → Guard de reentrada + claim atómico evitan el doble envío.');
  }

  // 4 — Cancelación antes de entregar
  banner(4, 'La cita se cancela antes de la entrega');
  {
    __resetHealth(); scheduler.__resetDeps();
    quiet();
    const events = [makeEvent({ uuid: 'cx', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
    const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: now });
    await scheduler.runCalendlyPoll();
    h.api.cancel('cx');
    await scheduler.runCalendlyDelivery();
    loud();
    line('Envíos (debe ser 0):', h.wa.sent.length);
    line('Estado final:', h.store._rows[0]?.status);
  }

  // 5 — Closer sin opt-in (anti-ban)
  banner(5, 'Closer sin opt-in (no le ha escrito a Juanito)');
  {
    __resetHealth(); scheduler.__resetDeps();
    quiet();
    const events = [makeEvent({ uuid: 'no', startInMin: 20, closerEmail: SALAZAR, nowMs: now })];
    const h = installHarness(scheduler, { events, optins: [], nowMs: now });
    await scheduler.runCalendlyPoll();
    await scheduler.runCalendlyDelivery();
    loud();
    line('Envíos (debe ser 0):', h.wa.sent.length);
    line('Estado final:', h.store._rows[0]?.status);
  }

  // 6 — Closer sin mapear → alerta a admin (decisión 5)
  banner(6, 'Host de Calendly sin closer mapeado → alerta a admin');
  {
    __resetHealth(); scheduler.__resetDeps();
    quiet();
    const events = [makeEvent({ uuid: 'um', startInMin: 120, closerEmail: 'nuevo.closer@30x.com', nowMs: now })];
    const h = installHarness(scheduler, { events, optins: [], nowMs: now });
    await scheduler.runCalendlyPoll();
    loud();
    line('Pushes agendados (debe ser 0):', h.store._rows.length);
    line('Closers sin mapear (health):', getHealth().unmapped.map((u) => u.email).join(', ') || '—');
    console.log('   Alerta enviada:');
    showSends(h.wa);
  }

  // 7 — Token muerto → alerta a admin (decisión 5)
  banner(7, 'Calendly rechaza el token (401) → alerta a admin');
  {
    __resetHealth(); scheduler.__resetDeps();
    quiet();
    const h = installHarness(scheduler, { events: [], nowMs: now, api: { throwError: 'Calendly 401: invalid token' } });
    await scheduler.runCalendlyPoll();
    loud();
    line('Último error (health):', getHealth().lastError);
    console.log('   Alerta enviada:');
    showSends(h.wa);
  }

  loud();
  scheduler.__resetDeps();
  console.log(`\n${'═'.repeat(72)}`);
  console.log('  ✅ Fin. Nada tocó red, DB ni WhatsApp — todo simulado en memoria.');
  console.log('═'.repeat(72) + '\n');
}

run().then(() => process.exit(0));
