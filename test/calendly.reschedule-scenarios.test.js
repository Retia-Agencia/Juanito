// test/calendly.reschedule-scenarios.test.js
// EL escenario del jefe (§18.AC), end-to-end sobre el harness (mock API + store en memoria
// + spy de WhatsApp + reloj inyectable). Sin DB nativa → corre en Windows.
//
//   9:00am  call con Ana Pérez
//   9:35am  Push 4 → el closer responde "3" (Reagendó)
//           Juanito pregunta la fecha → "hoy 3pm"  ← la reagenda va por OTRO link, no Calendly
//   2:35pm  Push 3 de la call reagendada
//   3:35pm  Push 4 de la call reagendada → el closer registra el resultado
//   Reporte: Ana cuenta UNA vez (la call de las 3pm), no dos.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';

import * as scheduler from '../src/scheduler/calendly.js';
import { __resetHealth } from '../src/calendly/health.js';
import { installHarness, makeEvent } from './helpers/calendly-harness.js';
import { planRescheduledPushes } from '../src/calendly/reschedule-logic.js';
import { decideOutcomeReply } from '../src/calendly/outcome-logic.js';
import { aggregateOutcomes } from '../src/calendly/outcome-report.js';
import { toSqliteUtc } from '../src/calendly/index.js';

const MIN = 60000;
const SALAZAR = 'sebastian.salazar@30x.com';
const SALAZAR_PHONE = '+573054312905';

// mar 14 jul 2026, 9:00am Bogotá = 14:00 UTC.
const CALL_9AM = Date.parse('2026-07-14T14:00:00Z');

beforeEach(() => {
  process.env.CALENDLY_DRY_RUN = 'false';
  // Salazar, el closer de fixture de este archivo, pasó a la conexión 'estadox' con la mudanza
  // del Calendly de EstadoX (2026-08-25). Su dry-run es INDEPENDIENTE del de 30x: sin esta línea
  // todos estos escenarios corren mudos y no se entrega nada.
  process.env.CALENDLY_DRY_RUN_ESTADOX = 'false';
  process.env.CALENDLY_REQUIRE_OPTIN = 'true';
  process.env.CALENDLY_PUSH3_LEAD_MIN = '25';
  process.env.CALENDLY_PUSH4_ENABLED = 'true';
  process.env.CALENDLY_CALL_DURATION_MIN = '30';
  process.env.CALENDLY_PUSH4_GRACE_MIN = '5';
  process.env.CALENDLY_RESCHEDULE_ENABLED = 'true';
  process.env.CALENDLY_RESCHEDULE_MAX_ASKED = '3';
  __resetHealth();
  scheduler.__resetDeps();
});

// El closer contesta el Push 4 → replicamos lo que hace outcome-capture contra el store.
// (outcome-capture importa la DB nativa; acá probamos la MISMA decisión + los mismos efectos.)
function closerResponde(store, texto, nowMs) {
  const outcome = store.getActiveOutcomeForCloser(SALAZAR_PHONE);
  assert.ok(outcome, 'hay un outcome abierto para el closer');
  const d = decideOutcomeReply(outcome, texto, { nowMs, tz: 'America/Bogota' });

  if (d.kind === 'asistencia') store.setOutcomeAsistencia(outcome.id, d.asistencia, texto);
  else if (d.kind === 'resultado') store.setOutcomeResultado(outcome.id, d.resultado, texto);
  else if (d.kind === 'reschedule') {
    const plan = planRescheduledPushes(outcome, d.startUtc, { nowMs });
    for (const p of plan.pushes) store.scheduleCalendlyPush(p);
    store.setOutcomeReschedule(outcome.id, {
      startUtc: toSqliteUtc(d.startUtc),
      uuid: plan.uuid,
      rawReply: texto,
    });
  } else if (d.kind === 'reschedule_unknown') {
    /* queda en awaiting_date: el cron diario repregunta */
  }
  return { decision: d, outcome };
}

test('el caso del jefe: 9am → reagendada a las 3pm por otro link → cuenta UNA vez', async () => {
  const clockNow = CALL_9AM - 20 * MIN; // 8:40am: el poll descubre la cita
  const events = [
    makeEvent({
      uuid: 'ana-9am',
      startIso: new Date(CALL_9AM).toISOString(),
      closerEmail: SALAZAR,
      prospectName: 'Ana Pérez',
      prospectPhone: '+57 310 999 8877',
      nowMs: clockNow,
    }),
  ];
  const h = installHarness(scheduler, { events, optins: [SALAZAR_PHONE], nowMs: clockNow });

  // 8:40am — el poll agenda Push 3 y Push 4 de la call de las 9.
  await scheduler.runCalendlyPoll();
  assert.ok(h.store._rows.find((r) => r.push_n === 4 && r.event_uuid === 'ana-9am'));

  // 9:35am — vence el Push 4 y Juanito pregunta cómo le fue.
  h.clock.ms = CALL_9AM + 35 * MIN;
  await scheduler.runCalendlyDelivery();
  const push4 = h.wa.sent.at(-1);
  assert.match(push4.text, /Registro de call.*Ana Pérez/s);
  assert.equal(h.store._outcomes.length, 1, 'se creó el pendiente al preguntar');

  // El closer responde "3" → Juanito NO cierra: queda esperando la fecha.
  const r1 = closerResponde(h.store, '3', h.clock.ms);
  assert.equal(r1.decision.followup, 'fecha');
  assert.equal(h.store._outcomes[0].status, 'awaiting_date');

  // "hoy 3pm" → agenda la call reagendada con uuid sintético (Calendly no sabe de esto).
  const r2 = closerResponde(h.store, 'hoy 3pm', h.clock.ms);
  assert.equal(r2.decision.kind, 'reschedule');

  const original = h.store._outcomes[0];
  assert.equal(original.status, 'answered');
  assert.equal(original.asistencia, 'reagendado');
  assert.equal(original.rescheduled_to, '2026-07-14 20:00:00', '3pm Bogotá = 20:00 UTC');
  assert.equal(original.reschedule_uuid, 'manual:ana-9am:1');

  // Se agendaron los DOS pushes de la call nueva, a la hora correcta.
  const nuevos = h.store._rows.filter((r) => r.event_uuid === 'manual:ana-9am:1');
  assert.equal(nuevos.length, 2);
  const p3 = nuevos.find((r) => r.push_n === 3);
  const p4 = nuevos.find((r) => r.push_n === 4);
  assert.equal(p3.due_at, '2026-07-14 19:35:00', 'Push 3: 2:35pm Bogotá (25 min antes)');
  assert.equal(p4.due_at, '2026-07-14 20:35:00', 'Push 4: 3:35pm Bogotá (start + 30 + 5)');

  // 2:35pm — llega el recordatorio precall de la call reagendada.
  h.clock.ms = Date.parse('2026-07-14T19:35:00Z');
  await scheduler.runCalendlyDelivery();
  assert.match(h.wa.sent.at(-1).text, /Push 3.*Ana Pérez/s);

  // 3:35pm — Juanito pregunta por la call reagendada y el closer la registra.
  h.clock.ms = Date.parse('2026-07-14T20:35:00Z');
  await scheduler.runCalendlyDelivery();
  assert.match(h.wa.sent.at(-1).text, /Registro de call.*Ana Pérez/s);
  assert.equal(h.store._outcomes.length, 2, 'la call reagendada tiene su propia fila');

  closerResponde(h.store, '1', h.clock.ms); // Show
  closerResponde(h.store, 'cerró', h.clock.ms); // Venta cerrada
  const reagendada = h.store._outcomes[1];
  assert.equal(reagendada.status, 'answered');
  assert.equal(reagendada.asistencia, 'show');
  assert.equal(reagendada.resultado, 'venta_cerrada');

  // EL PUNTO DE TODO ESTO: en el reporte del día, Ana cuenta UNA vez.
  const agg = aggregateOutcomes(
    h.store._outcomes.map((o) => ({ ...o, closer_name: 'Sebastián Salazar' }))
  );
  const stats = agg.second_brain['Sebastián Salazar'];
  assert.equal(stats.total, 1, 'una sola call, no dos');
  assert.equal(stats.movidas, 1);
  assert.equal(stats.show, 1);
  assert.equal(stats.venta_cerrada, 1);
  assert.equal(stats.cumplimiento, 100);
});

test('si la reagenda SÍ entra por Calendly, el push sintético se cancela (no se pregunta 2 veces)', async () => {
  const clockNow = CALL_9AM + 35 * MIN;
  const h = installHarness(scheduler, { events: [], optins: [SALAZAR_PHONE], nowMs: clockNow });

  // Estado tras el "3 · Reagendó → hoy 3pm" del test anterior.
  h.store.createPendingOutcome({
    event_uuid: 'ana-9am',
    program: 'second_brain',
    closer_email: SALAZAR,
    closer_phone: SALAZAR_PHONE,
    lead_name: 'Ana Pérez',
    lead_phone: '+57 310 999 8877',
    call_start: '2026-07-14 14:00:00',
  });
  const o = h.store.getActiveOutcomeForCloser(SALAZAR_PHONE);
  h.store.setOutcomeAsistencia(o.id, 'reagendado', '3');
  const plan = planRescheduledPushes(o, new Date('2026-07-14T20:00:00Z'), { nowMs: clockNow });
  for (const p of plan.pushes) h.store.scheduleCalendlyPush(p);
  h.store.setOutcomeReschedule(o.id, { startUtc: '2026-07-14 20:00:00', uuid: plan.uuid });

  // …pero el lead terminó agendando por Calendly: aparece un evento REAL para el mismo lead.
  h.api._events.set(
    'ana-3pm-real',
    makeEvent({
      uuid: 'ana-3pm-real',
      startIso: '2026-07-14T20:00:00Z',
      closerEmail: SALAZAR,
      prospectName: 'Ana Pérez',
      prospectPhone: '+57 310 999 8877',
      nowMs: clockNow,
    })
  );

  await scheduler.runCalendlyPoll();

  // Los sintéticos quedan cancelados y el outcome apunta al evento real.
  const sinteticos = h.store._rows.filter((r) => r.event_uuid === 'manual:ana-9am:1');
  assert.ok(sinteticos.length >= 1);
  assert.ok(sinteticos.every((r) => r.status === 'skipped'), 'ningún sintético sigue vivo');
  assert.match(sinteticos[0].message, /superseded por evento real ana-3pm-real/);
  assert.equal(h.store._outcomes[0].reschedule_uuid, 'ana-3pm-real');

  // Y el Push 4 que se entrega a las 3:35pm es UNO solo (el del evento real).
  h.clock.ms = Date.parse('2026-07-14T20:35:00Z');
  const antes = h.wa.sent.length;
  await scheduler.runCalendlyDelivery();
  const push4s = h.wa.sent.slice(antes).filter((m) => /Registro de call/.test(m.text));
  assert.equal(push4s.length, 1, 'una sola pregunta, no dos');
});

test('reagenda sin fecha: se insiste al día siguiente y al tope se cierra sola', async () => {
  const clockNow = CALL_9AM + 35 * MIN;
  const h = installHarness(scheduler, { events: [], optins: [SALAZAR_PHONE], nowMs: clockNow });

  h.store.createPendingOutcome({
    event_uuid: 'ana-9am',
    program: 'second_brain',
    closer_email: SALAZAR,
    closer_phone: SALAZAR_PHONE,
    lead_name: 'Ana Pérez',
    call_start: '2026-07-14 14:00:00',
  });
  const o = h.store.getActiveOutcomeForCloser(SALAZAR_PHONE);
  const d = decideOutcomeReply(o, 'aún no sabemos', { nowMs: clockNow });
  assert.equal(d.kind, 'reprompt'); // todavía no dijo la asistencia

  h.store.setOutcomeAsistencia(o.id, 'reagendado', '3');
  assert.equal(decideOutcomeReply(h.store._outcomes[0], 'aún no sabemos').kind, 'reschedule_unknown');

  // Mismo día: no se le insiste (acaba de contestar).
  assert.equal(await scheduler.runReschedulePrompts(), 0);

  // Al día siguiente sí.
  h.clock.ms += 24 * 60 * MIN;
  assert.equal(await scheduler.runReschedulePrompts(), 1);
  assert.match(h.wa.sent.at(-1).text, /¿Ya quedó fecha con \*Ana Pérez\*\?/);

  // A los 3 días se cierra sin fecha (deja de ocupar la ventana de captura del closer).
  h.clock.ms += 24 * 60 * MIN;
  await scheduler.runReschedulePrompts();
  h.clock.ms += 24 * 60 * MIN;
  await scheduler.runReschedulePrompts();
  h.clock.ms += 24 * 60 * MIN;
  await scheduler.runReschedulePrompts();

  const row = h.store._outcomes[0];
  assert.equal(row.status, 'answered');
  assert.equal(row.rescheduled_to, null);
  assert.equal(h.store.getActiveOutcomeForCloser(SALAZAR_PHONE), null, 'ya no secuestra respuestas');

  // En el reporte cuenta como movida, no como call.
  const stats = aggregateOutcomes([{ ...row, closer_name: 'Sebastián Salazar' }]).second_brain[
    'Sebastián Salazar'
  ];
  assert.equal(stats.total, 0);
  assert.equal(stats.reagendado, 1);
});
