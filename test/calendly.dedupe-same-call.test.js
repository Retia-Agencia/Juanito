// test/calendly.dedupe-same-call.test.js
// §18.AU — identidad de una call: cuándo dos filas de `calendly_pushes` son la MISMA.
//
// Tier 0 (puro). El bug: la agenda del jefe agrupaba por `event_uuid`, y como hay tres fuentes
// que acuñan uuid propio (Calendly pelado, 'hubspot:<id>', 'manual:<raíz>:<n>'), una misma call
// podía quedar con dos filas vivas y contarse dos veces. Sebastián Rodríguez lo reportó el
// 2026-07-29: el reporte le puso 7 calls y tenía 6.
//
// ⚠️ El test que importa es el del FALSO POSITIVO. El arreglo obvio —deduplicar por closer +
// minuto— es incorrecto: medido sobre 2 meses de producción, de 14 colisiones solo 6 eran la
// misma call; las otras 8 son dobles reservas reales (dos leads distintos en el mismo slot del
// mismo closer). Deduplicar por slot habría escondido 8 calls que sí existen.
//
// Los casos de abajo son los 14 pares REALES de la base de producción (nombres y teléfonos tal
// cual), para que la regla quede clavada contra datos y no contra un ejemplo inventado.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dedupeSameCall, sourceRankOf } from '../src/calendly/reschedule-logic.js';

const row = (event_uuid, closer_email, call_start, prospect_name, prospect_phone = null) => ({
  event_uuid,
  closer_email,
  call_start,
  prospect_name,
  prospect_phone,
});

// ─── Precedencia de la fuente ─────────────────────────────────────────────────

test('sourceRankOf: Calendly manda sobre HubSpot, y HubSpot sobre la reagenda dictada', () => {
  assert.equal(sourceRankOf('6ec89fc3-27b7-47ed-b6c8-6bdfe258f51b'), 0);
  assert.equal(sourceRankOf('hubspot:113752024882'), 1);
  assert.equal(sourceRankOf('manual:b9bd368b-9ff2-42a0-b4aa-db9f240a912f:1'), 2);
});

// ─── Duplicados REALES: se colapsan ───────────────────────────────────────────

test('caso Sebas (el reportado): hubspot + manual, mismo teléfono → 1 call', () => {
  // La colisión exacta que infló su agenda a 7. Los nombres NO coinciden ("Jonathan Jonathan"
  // es el título del registro del CRM); el teléfono es lo que los une.
  const out = dedupeSameCall([
    row('hubspot:113752024882', 'sebastian@30x.com', '2026-07-29 16:30:00', 'Jonathan Jonathan', '573104407335'),
    row('manual:b9bd368b-9ff2-42a0-b4aa-db9f240a912f:1', 'sebastian@30x.com', '2026-07-29 16:30:00', 'Jonathan bean', '573104407335'),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].event_uuid, 'hubspot:113752024882', 'sobrevive la de mejor procedencia');
});

test('caso Pablo Suárez: mismo lead, mismo minuto, hubspot + manual → 1 call', () => {
  const out = dedupeSameCall([
    row('hubspot:113859173890', 'pablosuarez@30x.com', '2026-07-29 15:00:00', 'Fabio Diaz', '573158712865'),
    row('manual:hubspot:113752272311:1', 'pablosuarez@30x.com', '2026-07-29 15:00:00', 'Fabio Diaz', '573158712865'),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].event_uuid, 'hubspot:113859173890');
});

test('nombres muy distintos pero MISMO teléfono → es el mismo lead', () => {
  // Caso real de Lucas: "Lorena" (como quedó en el CRM) vs "Lorenzana Rebollo".
  const out = dedupeSameCall([
    row('hubspot:113752149111', 'lucas.mendoza@30x.com', '2026-07-27 23:00:00', 'Lorena', '507 6023-6359'),
    row('manual:840080da-c437-4724-8d58-99219ebf1f77:1', 'lucas.mendoza@30x.com', '2026-07-27 23:00:00', 'Lorenzana Rebollo', '507 6023-6359'),
  ]);
  assert.equal(out.length, 1);
});

test('sin teléfono en ninguna, mismo nombre → cae al nombre y colapsa', () => {
  const out = dedupeSameCall([
    row('87d761a6-0184-49a5-a7ff-7c326ece45a3', 'sebastian@30x.com', '2026-07-28 17:30:00', 'Francisco Leonardo Patarroyo'),
    row('baee70c4-64d6-40d6-8a93-08a8035ac548', 'sebastian@30x.com', '2026-07-28 17:30:00', 'Francisco Leonardo Patarroyo'),
  ]);
  assert.equal(out.length, 1);
});

test('el mismo teléfono con prefijos de país distintos sigue siendo el mismo lead', () => {
  const out = dedupeSameCall([
    row('uuid-a', 'sebastian@30x.com', '2026-07-29 16:30:00', 'Jonathan', '+57 310 4407335'),
    row('manual:uuid-a:1', 'sebastian@30x.com', '2026-07-29 16:30:00', 'Jonathan', '573104407335'),
  ]);
  assert.equal(out.length, 1);
});

// ─── Falsos positivos: NO se pueden colapsar ──────────────────────────────────

test('DOBLE RESERVA: dos leads distintos en el mismo slot del mismo closer → 2 calls', () => {
  // Caso real de Daniela. Si esto colapsara, el jefe vería una call menos de las que hay.
  const out = dedupeSameCall([
    row('ad263de2-bb80-467d-971d-e027e1bb24db', 'daniela.camacho@30x.com', '2026-07-23 17:30:00', 'Rafael Schwart', '+17867813161'),
    row('f3ee37b6-8f0e-47f6-843a-4d7aeef45470', 'daniela.camacho@30x.com', '2026-07-23 17:30:00', 'María Isabel  Castrillon', '573166195633'),
  ]);
  assert.equal(out.length, 2, 'son dos calls distintas');
});

test('doble reserva donde UNA no tiene teléfono → el nombre decide, y son distintos', () => {
  const out = dedupeSameCall([
    row('08a6e638-b8b4-417d-9ad2-334d19bb7fff', 'lucas.mendoza@30x.com', '2026-07-23 15:00:00', 'Ana Sofia Taboada', null),
    row('68479861-7444-4d2e-9681-bd1f52e60412', 'lucas.mendoza@30x.com', '2026-07-23 15:00:00', 'Sebastián García Vega', '573022517147'),
  ]);
  assert.equal(out.length, 2);
});

test('una fila manual y otra de Calendly con leads DISTINTOS no se tocan', () => {
  // Caso real de Pablo Lozano: la reagenda dictada de Jorge cayó en el slot de Andrea.
  const out = dedupeSameCall([
    row('9606f47d-406a-4b82-8341-bce170429da1', 'pablo.lozano@30x.com', '2026-07-23 20:30:00', 'Andrea chirivi', '573203048649'),
    row('manual:43cbaf37-b73d-41ef-9968-c5065ff9a0a4:1', 'pablo.lozano@30x.com', '2026-07-23 20:30:00', 'Jorge Regalado ', '593979061279'),
  ]);
  assert.equal(out.length, 2);
});

test('mismo lead pero closers DISTINTOS → son dos calls', () => {
  const out = dedupeSameCall([
    row('uuid-a', 'sebastian@30x.com', '2026-07-29 16:30:00', 'Jonathan', '573104407335'),
    row('uuid-b', 'daniela.camacho@30x.com', '2026-07-29 16:30:00', 'Jonathan', '573104407335'),
  ]);
  assert.equal(out.length, 2);
});

test('mismo lead y closer pero a horas distintas → son dos calls (una es la reagenda)', () => {
  const out = dedupeSameCall([
    row('uuid-a', 'sebastian@30x.com', '2026-07-29 16:30:00', 'Jonathan', '573104407335'),
    row('manual:uuid-a:1', 'sebastian@30x.com', '2026-07-30 21:00:00', 'Jonathan', '573104407335'),
  ]);
  assert.equal(out.length, 2);
});

test('filas sin closer no se agrupan entre sí', () => {
  // Sin closer no hay identidad de call que valga: agruparlas escondería calls reales.
  const out = dedupeSameCall([
    row('uuid-a', null, '2026-07-29 16:30:00', 'Ana', null),
    row('uuid-b', null, '2026-07-29 16:30:00', 'Beto', null),
  ]);
  assert.equal(out.length, 2);
});

// ─── Forma del resultado ──────────────────────────────────────────────────────

test('preserva el orden de entrada (la agenda se lee cronológicamente)', () => {
  const out = dedupeSameCall([
    row('c1', 'sebastian@30x.com', '2026-07-29 12:30:00', 'Carlos', '573001112222'),
    row('hubspot:h1', 'sebastian@30x.com', '2026-07-29 16:30:00', 'Jonathan', '573104407335'),
    row('manual:m1:1', 'sebastian@30x.com', '2026-07-29 16:30:00', 'Jonathan bean', '573104407335'),
    row('c2', 'sebastian@30x.com', '2026-07-29 20:00:00', 'Jaime', '573004445555'),
  ]);
  assert.deepEqual(out.map((r) => r.event_uuid), ['c1', 'hubspot:h1', 'c2']);
});

test('sin colisiones no cambia nada; lista vacía no rompe', () => {
  const rows = [
    row('c1', 'sebastian@30x.com', '2026-07-29 12:30:00', 'Carlos', '573001112222'),
    row('c2', 'sebastian@30x.com', '2026-07-29 20:00:00', 'Jaime', '573004445555'),
  ];
  assert.deepEqual(dedupeSameCall(rows).map((r) => r.event_uuid), ['c1', 'c2']);
  assert.deepEqual(dedupeSameCall([]), []);
  assert.deepEqual(dedupeSameCall(), []);
});
