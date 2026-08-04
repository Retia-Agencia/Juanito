// test/data.setteos.test.js
// Tests del SQL real de la tabla `setteos` (§18.AZ): dedup por (closer, lead, fecha),
// acumulación de flags entre tandas, coherencia del embudo, aislamiento por closer y el
// resumen que alimenta /missetteos.
// REQUIERE better-sqlite3 nativo → corre en Docker/VPS, no en Windows.
// El parseo del texto libre está en test/setteo.parse.test.js (puro).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'setteos-'));
const DB_PATH = join(dir, 'test.sqlite');
process.env.DB_PATH = DB_PATH;

let db;
let normalizeLeadName;

before(async () => {
  execFileSync('node', ['src/db/migrate.js'], { env: { ...process.env, DB_PATH }, stdio: 'pipe' });
  db = await import('../src/db/index.js');
  ({ normalizeLeadName } = await import('../src/common/utils.js'));
});

after(() => rmSync(dir, { recursive: true, force: true }));

const SEBAS = 'sebastian@30x.com';
const PABLO = 'pablo.lozano@30x.com';

// Helper: arma el payload dejando que lead_norm salga del normalizador real (mismo camino
// que producción — si el normalizador cambia, estos tests lo notan).
const setteo = (over = {}) => {
  const leadName = over.leadName || 'Juan Pérez';
  return {
    closerEmail: SEBAS,
    closerPhone: '+573102212005',
    closerName: 'Sebastian Rodriguez',
    leadName,
    leadNorm: normalizeLeadName(leadName),
    fecha: '2026-08-03',
    ...over,
  };
};

test('inserta un setteo y lo devuelve por closer + ventana', () => {
  db.upsertSetteo(setteo({ leadName: 'Ana Gómez', contesto: 1 }));
  const rows = db.listSetteosForCloser({ closerEmail: SEBAS, desde: '2026-08-03', hasta: '2026-08-03' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lead_name, 'Ana Gómez');
  assert.equal(rows[0].contesto, 1);
  assert.equal(rows[0].agendo, 0);
});

// La regla del training S3: "una interacción por día por canal" → 1 lead tocado = 1 setteo.
// Sin esto, un closer que le escribe 4 veces al mismo lead reportaría 4 setteos.
test('mismo lead, mismo día, dos reportes → UNA fila (dedup)', () => {
  db.upsertSetteo(setteo({ leadName: 'Carlos Ruiz' }));
  db.upsertSetteo(setteo({ leadName: 'carlos  RUIZ.' })); // mismas letras, otro formato
  const rows = db
    .listSetteosForCloser({ closerEmail: SEBAS, desde: '2026-08-03', hasta: '2026-08-03' })
    .filter((r) => r.lead_norm === 'carlos ruiz');
  assert.equal(rows.length, 1);
});

// El caso real: el closer reporta en tandas. Un UPDATE plano borraría el flag anterior.
test('los flags se ACUMULAN entre tandas y nunca bajan solos', () => {
  db.upsertSetteo(setteo({ leadName: 'Marta Díaz', contesto: 1 }));
  db.upsertSetteo(setteo({ leadName: 'Marta Díaz', agendo: 1 })); // 2h después, sin repetir "contestó"
  const r = db
    .listSetteosForCloser({ closerEmail: SEBAS, desde: '2026-08-03', hasta: '2026-08-03' })
    .find((x) => x.lead_norm === 'marta diaz');
  assert.equal(r.contesto, 1, 'el "contestó" del primer mensaje no se puede perder');
  assert.equal(r.agendo, 1);
  assert.equal(r.vendio, 0);
});

test('coherencia del embudo: agendó o vendió implican contestó', () => {
  db.upsertSetteo(setteo({ leadName: 'Luis Toro', agendo: 1 }));       // sin decir "contestó"
  db.upsertSetteo(setteo({ leadName: 'Sara Vega', vendio: 1 }));
  const rows = db.listSetteosForCloser({ closerEmail: SEBAS, desde: '2026-08-03', hasta: '2026-08-03' });
  assert.equal(rows.find((r) => r.lead_norm === 'luis toro').contesto, 1);
  assert.equal(rows.find((r) => r.lead_norm === 'sara vega').contesto, 1);
});

test('el cruce con HubSpot no se borra con una 2ª mención que no consultó el CRM', () => {
  db.upsertSetteo(setteo({ leadName: 'Elena Paz', hubspotContactId: '551', hubspotMatch: 'exact' }));
  db.upsertSetteo(setteo({ leadName: 'Elena Paz', agendo: 1 })); // sin datos de HubSpot
  const r = db
    .listSetteosForCloser({ closerEmail: SEBAS, desde: '2026-08-03', hasta: '2026-08-03' })
    .find((x) => x.lead_norm === 'elena paz');
  assert.equal(r.hubspot_contact_id, '551');
  assert.equal(r.hubspot_match, 'exact');
});

test('el mismo lead en OTRA fecha es otro setteo', () => {
  db.upsertSetteo(setteo({ leadName: 'Rita Sol', fecha: '2026-08-03' }));
  db.upsertSetteo(setteo({ leadName: 'Rita Sol', fecha: '2026-08-04' }));
  const rows = db
    .listSetteosForCloser({ closerEmail: SEBAS, desde: '2026-08-01', hasta: '2026-08-31' })
    .filter((r) => r.lead_norm === 'rita sol');
  assert.equal(rows.length, 2);
});

// El aislamiento es el requisito de privacidad: un closer nunca ve ni toca lo de otro.
test('aislamiento: dos closers pueden reportar el MISMO lead sin pisarse', () => {
  db.upsertSetteo(setteo({ leadName: 'Lead Compartido', contesto: 1 }));
  db.upsertSetteo(setteo({ closerEmail: PABLO, closerName: 'Pablo Lozano', leadName: 'Lead Compartido', agendo: 1 }));

  const deSebas = db.listSetteosForCloser({ closerEmail: SEBAS, desde: '2026-08-03', hasta: '2026-08-03' })
    .filter((r) => r.lead_norm === 'lead compartido');
  const dePablo = db.listSetteosForCloser({ closerEmail: PABLO, desde: '2026-08-03', hasta: '2026-08-03' })
    .filter((r) => r.lead_norm === 'lead compartido');

  assert.equal(deSebas.length, 1);
  assert.equal(dePablo.length, 1);
  assert.equal(deSebas[0].agendo, 0, 'el flag de Pablo no puede aparecer en la fila de Sebas');
  assert.equal(dePablo[0].agendo, 1);
});

test('deleteSetteo con el email de OTRO closer no borra nada', () => {
  db.upsertSetteo(setteo({ leadName: 'Intocable', fecha: '2026-08-10' }));
  const row = db.listSetteosForCloser({ closerEmail: SEBAS, desde: '2026-08-10', hasta: '2026-08-10' })[0];

  assert.equal(db.deleteSetteo({ id: row.id, closerEmail: PABLO }), 0, 'un id ajeno no debe borrar');
  assert.equal(db.listSetteosForCloser({ closerEmail: SEBAS, desde: '2026-08-10', hasta: '2026-08-10' }).length, 1);

  assert.equal(db.deleteSetteo({ id: row.id, closerEmail: SEBAS }), 1);
  assert.equal(db.listSetteosForCloser({ closerEmail: SEBAS, desde: '2026-08-10', hasta: '2026-08-10' }).length, 0);
});

test('updateSetteoFlags es la única vía para BAJAR un flag, y respeta al dueño', () => {
  db.upsertSetteo(setteo({ leadName: 'Error Mío', fecha: '2026-08-11', agendo: 1 }));
  const row = db.listSetteosForCloser({ closerEmail: SEBAS, desde: '2026-08-11', hasta: '2026-08-11' })[0];

  assert.equal(db.updateSetteoFlags({ id: row.id, closerEmail: PABLO, agendo: 0 }), 0);
  assert.equal(db.updateSetteoFlags({ id: row.id, closerEmail: SEBAS, agendo: 0 }), 1);

  const after_ = db.listSetteosForCloser({ closerEmail: SEBAS, desde: '2026-08-11', hasta: '2026-08-11' })[0];
  assert.equal(after_.agendo, 0);
  assert.equal(after_.contesto, 1, 'bajar "agendó" no toca "contestó"');
});

// Un lead con cita agendada ya lo mide el Push 4. Contarlo también como setteo sería
// contar la misma gestión dos veces.
test('summarizeSetteos: los leads de call salen del total y las tasas son del embudo', () => {
  const F = '2026-08-20';
  const s = (over) => db.upsertSetteo(setteo({ fecha: F, ...over }));
  s({ leadName: 'L1', contesto: 1, agendo: 1 });
  s({ leadName: 'L2', contesto: 1 });
  s({ leadName: 'L3' });                                  // no contestó
  s({ leadName: 'L4' });                                  // no contestó
  s({ leadName: 'L5', agendo: 1, vendio: 1 });
  s({ leadName: 'L6', contesto: 1, esCall: 1 });          // es lead de call → fuera

  const sum = db.summarizeSetteos({ closerEmail: SEBAS, desde: F, hasta: F });
  assert.equal(sum.total, 5, 'el lead de call no cuenta en el total');
  assert.equal(sum.eranCall, 1);
  assert.equal(sum.contestaron, 3);
  assert.equal(sum.agendaron, 2);
  assert.equal(sum.vendieron, 1);
  assert.equal(sum.tasaRespuesta, 3 / 5);
  // La tasa que importa: agendados sobre los que CONTESTARON, no sobre el total.
  assert.equal(sum.tasaSetteo, 2 / 3);
});

test('summarizeSetteos sin datos no divide por cero', () => {
  const sum = db.summarizeSetteos({ closerEmail: SEBAS, desde: '2030-01-01', hasta: '2030-01-01' });
  assert.equal(sum.total, 0);
  assert.equal(sum.tasaRespuesta, null);
  assert.equal(sum.tasaSetteo, null);
});

test('setteosByCloser agrupa la ventana por closer', () => {
  const F = '2026-09-01';
  db.upsertSetteo(setteo({ fecha: F, leadName: 'A1', contesto: 1 }));
  db.upsertSetteo(setteo({ fecha: F, leadName: 'A2', agendo: 1 }));
  db.upsertSetteo(setteo({ closerEmail: PABLO, closerName: 'Pablo Lozano', fecha: F, leadName: 'B1' }));

  const rows = db.setteosByCloser({ desde: F, hasta: F });
  const sebas = rows.find((r) => r.closer_email === SEBAS);
  const pablo = rows.find((r) => r.closer_email === PABLO);
  assert.equal(sebas.setteos, 2);
  assert.equal(sebas.agendaron, 1);
  assert.equal(pablo.setteos, 1);
  assert.equal(pablo.contestaron, 0);
});

test('upsertSetteo exige closer, lead y fecha (nunca escribe una fila huérfana)', () => {
  assert.throws(() => db.upsertSetteo(setteo({ closerEmail: null })), /obligatorios/);
  assert.throws(() => db.upsertSetteo(setteo({ leadNorm: '' })), /obligatorios/);
  assert.throws(() => db.upsertSetteo(setteo({ fecha: null })), /obligatorios/);
});
