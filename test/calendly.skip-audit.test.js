// test/calendly.skip-audit.test.js
// Auditoría horaria de skips: avisarle al admin cuando un closer pierde pushes.
//
// Cierra el pendiente de "detectar pushes que no salen sin depender del reporte del closer"
// (7ac8cef). El caso Daniela se descubrió porque un humano lo contó dos días después: los 8
// skips estaban en la DB desde el primer minuto y nada los miró.
//
// Lo que más importa acá NO es que alerte, sino que NO alerte de más: cancelaciones, reagendas
// y duplicados de HubSpot son operación normal y son la mayoría de los skips. Si se colaran,
// el admin aprendería a ignorar la alerta y volveríamos al punto de partida.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';
process.env.ADMIN_LID = '129446371655733@lid';
process.env.CALENDLY_SKIP_ALERT_MIN = '2';

const scheduler = await import('../src/scheduler/calendly.js');
const { installHarness } = await import('./helpers/calendly-harness.js');
const { SKIP_SLUGS } = await import('../src/calendly/skip-reasons.js');
const { __resetHealth } = await import('../src/calendly/health.js');

const ADMIN = process.env.ADMIN_LID;
const NOW = Date.parse('2026-07-30T18:00:00Z');
const sqlUtc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// Siembra filas ya saltadas directamente en el store: la auditoría lee la DB, no depende
// de cómo se llegó al skip.
function sembrar(h, filas) {
  let id = 500;
  for (const f of filas) {
    h.store._rows.push({
      id: id++,
      push_n: 3,
      status: 'skipped',
      skip_reason: f.slug,
      closer_email: f.closer,
      prospect_name: f.lead || 'Lead X',
      call_start: sqlUtc(NOW - (f.horasAtras ?? 1) * 3600000),
      due_at: sqlUtc(NOW - (f.horasAtras ?? 1) * 3600000),
      message: 'msg',
    });
  }
}

function armar() {
  __resetHealth(); // limpia el dedupe de 6h de shouldAlert entre tests
  return installHarness(scheduler, { nowMs: NOW, events: [], optins: [] });
}

test('alerta cuando un closer acumula pushes perdidos', async () => {
  const h = armar();
  sembrar(h, [
    { closer: 'daniela.camacho@30x.com', slug: SKIP_SLUGS.SIN_OPTIN, lead: 'Julián segura' },
    { closer: 'daniela.camacho@30x.com', slug: SKIP_SLUGS.OBSOLETO, lead: 'David Pulido' },
  ]);

  const avisados = await scheduler.runSkipAudit();

  assert.equal(avisados, 1);
  assert.equal(h.wa.sent.length, 1, 'un DM al admin');
  assert.equal(h.wa.sent[0].to, ADMIN);
  assert.match(h.wa.sent[0].text, /Daniela Camacho/, 'nombra al closer, no solo su email');
  assert.match(h.wa.sent[0].text, /2 push/, 'dice cuántos se perdieron');
  assert.match(h.wa.sent[0].text, /closers\.js/, 'dice por dónde empezar a revisar');

  scheduler.__resetDeps();
});

test('NO alerta por causas legítimas: cancelada, reagendada, duplicado de HubSpot', async () => {
  const h = armar();
  sembrar(h, [
    { closer: 'pablo.lozano@30x.com', slug: SKIP_SLUGS.CANCELADA },
    { closer: 'pablo.lozano@30x.com', slug: SKIP_SLUGS.REAGENDADA },
    { closer: 'pablo.lozano@30x.com', slug: SKIP_SLUGS.RESCHEDULED },
    { closer: 'pablo.lozano@30x.com', slug: SKIP_SLUGS.SUPERSEDED },
    { closer: 'pablo.lozano@30x.com', slug: SKIP_SLUGS.CANCELADA },
  ]);

  const avisados = await scheduler.runSkipAudit();

  assert.equal(avisados, 0, '5 skips legítimos no son un problema');
  assert.equal(h.wa.sent.length, 0, 'cero ruido al admin');

  scheduler.__resetDeps();
});

test('respeta el umbral: un solo push perdido no alerta', async () => {
  const h = armar();
  sembrar(h, [{ closer: 'lucas.mendoza@30x.com', slug: SKIP_SLUGS.SIN_HILO }]);

  assert.equal(await scheduler.runSkipAudit(), 0);
  assert.equal(h.wa.sent.length, 0);

  scheduler.__resetDeps();
});

test('mezcla real: solo cuenta los accionables del closer afectado', async () => {
  const h = armar();
  sembrar(h, [
    // Ruido normal de un día cualquiera, repartido.
    { closer: 'pablo.lozano@30x.com', slug: SKIP_SLUGS.CANCELADA },
    { closer: 'pablo.lozano@30x.com', slug: SKIP_SLUGS.SUPERSEDED },
    { closer: 'sebastian@30x.com', slug: SKIP_SLUGS.REAGENDADA },
    // El closer roto.
    { closer: 'daniela.camacho@30x.com', slug: SKIP_SLUGS.SIN_OPTIN },
    { closer: 'daniela.camacho@30x.com', slug: SKIP_SLUGS.SIN_OPTIN },
    { closer: 'daniela.camacho@30x.com', slug: SKIP_SLUGS.CANCELADA }, // no suma
  ]);

  const avisados = await scheduler.runSkipAudit();

  assert.equal(avisados, 1, 'solo alerta por Daniela');
  assert.equal(h.wa.sent.length, 1);
  assert.match(h.wa.sent[0].text, /Daniela Camacho: 2 push/, 'cuenta 2, no 3: la cancelada no entra');

  scheduler.__resetDeps();
});

test('la ventana de 24h deja fuera lo viejo', async () => {
  const h = armar();
  sembrar(h, [
    { closer: 'daniela.camacho@30x.com', slug: SKIP_SLUGS.SIN_OPTIN, horasAtras: 30 },
    { closer: 'daniela.camacho@30x.com', slug: SKIP_SLUGS.SIN_OPTIN, horasAtras: 40 },
  ]);

  assert.equal(await scheduler.runSkipAudit(), 0, 'un problema de anteayer no se re-alerta hoy');
  assert.equal(h.wa.sent.length, 0);

  scheduler.__resetDeps();
});

test('no spamea: dos corridas seguidas mandan una sola alerta (dedupe 6h)', async () => {
  const h = armar();
  sembrar(h, [
    { closer: 'daniela.camacho@30x.com', slug: SKIP_SLUGS.SIN_OPTIN },
    { closer: 'daniela.camacho@30x.com', slug: SKIP_SLUGS.OBSOLETO },
  ]);

  await scheduler.runSkipAudit();
  await scheduler.runSkipAudit(); // el cron corre cada hora; el problema sigue ahí

  assert.equal(h.wa.sent.length, 1, 'la segunda corrida no vuelve a molestar al admin');

  scheduler.__resetDeps();
});

// ─── Lo que se rompió en producción el 2026-08-26 ─────────────────────────────

test('🩸 el dedup SOBREVIVE al reinicio del proceso', async () => {
  // El bug real: `shouldAlert` vive en memoria, así que cada arranque del bot re-armaba la
  // alerta. Ese día el bot arrancó ~9 veces (4 caídas por 428 + los despliegues) y mandó ~9
  // avisos por las MISMAS dos filas muertas. El ruido escalaba justo cuando el sistema estaba
  // peor, que es cuando menos sirve.
  const h = armar();
  sembrar(h, [
    { closer: 'daniela.camacho@30x.com', slug: SKIP_SLUGS.OBSOLETO },
    { closer: 'daniela.camacho@30x.com', slug: SKIP_SLUGS.OBSOLETO },
  ]);

  await scheduler.runSkipAudit();
  assert.equal(h.wa.sent.length, 1);

  __resetHealth(); // ← esto es lo que hace un reinicio: borra el dedup EN MEMORIA
  await scheduler.runSkipAudit();

  assert.equal(h.wa.sent.length, 1, 'tras el reinicio NO se repite: el dedup vive en la DB');

  scheduler.__resetDeps();
});

test('🩸 una causa YA CURADA deja de contar: el closer que después sí escribió', async () => {
  // El caso de Dana. Perdió dos pushes de madrugada sin opt-in y escribió a Juanito a las
  // 14:28. La alerta siguió diciendo "el closer no ha escrito a Juanito" durante horas, porque
  // `skip_reason` es la etiqueta congelada del momento del skip.
  __resetHealth();
  const h = installHarness(scheduler, {
    nowMs: NOW,
    events: [],
    // Ya tiene opt-in AHORA, aunque los skips son de antes.
    optins: [{ phone: '+573018094666', source: 'self', contactJid: '777@lid' }],
  });
  sembrar(h, [
    { closer: 'daniela.camacho@30x.com', slug: SKIP_SLUGS.SIN_OPTIN },
    { closer: 'daniela.camacho@30x.com', slug: SKIP_SLUGS.SIN_OPTIN },
  ]);

  assert.equal(await scheduler.runSkipAudit(), 0, 'la causa ya no existe: nada que diagnosticar');
  assert.equal(h.wa.sent.length, 0);

  scheduler.__resetDeps();
});

test('curar NO borra los pushes realmente perdidos: obsoleto sigue contando', async () => {
  // El límite del arreglo anterior, y es a propósito. `obsoleto` puede venir de la falta de
  // opt-in, pero también de WhatsApp caído o del bot reiniciándose. Borrarlo en silencio por
  // una corazonada es justo lo que esta auditoría existe para impedir.
  __resetHealth();
  const h = installHarness(scheduler, {
    nowMs: NOW,
    events: [],
    optins: [{ phone: '+573018094666', source: 'self', contactJid: '777@lid' }],
  });
  sembrar(h, [
    { closer: 'daniela.camacho@30x.com', slug: SKIP_SLUGS.SIN_OPTIN }, // curado → no cuenta
    { closer: 'daniela.camacho@30x.com', slug: SKIP_SLUGS.OBSOLETO },
    { closer: 'daniela.camacho@30x.com', slug: SKIP_SLUGS.OBSOLETO },
  ]);

  assert.equal(await scheduler.runSkipAudit(), 1);
  assert.match(h.wa.sent[0].text, /2 push/, 'cuenta 2, no 3: el sin-optin curado se cayó');

  scheduler.__resetDeps();
});

test('la recomendación de revisar closers.js solo aparece si el problema ES de registro', async () => {
  // Colgarla de TODA alerta mandaba a revisar el teléfono de un closer cuyo teléfono nunca fue
  // el problema. Eso quema la credibilidad del aviso entero.
  __resetHealth();
  const h = armar();
  sembrar(h, [
    { closer: 'pablo.lozano@30x.com', slug: SKIP_SLUGS.OBSOLETO },
    { closer: 'pablo.lozano@30x.com', slug: SKIP_SLUGS.OBSOLETO },
  ]);

  await scheduler.runSkipAudit();

  assert.equal(h.wa.sent.length, 1);
  assert.match(h.wa.sent[0].text, /2 push/);
  assert.ok(
    !h.wa.sent[0].text.includes('closers.js'),
    'sin causa de registro, no manda a revisar el roster'
  );

  scheduler.__resetDeps();
});
