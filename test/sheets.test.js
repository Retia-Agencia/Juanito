// test/sheets.test.js
// Cubre el código PURO del reporte diario de Sheets (§18.B): parseo de la marca
// temporal, ventana de Bogotá, agregación con porcentajes y formato del mensaje.
// No toca red ni DB → corre en Windows sin better-sqlite3.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSubmittedAt } from '../src/sheets/parse.js';
import { computeWindow, zonedParts } from '../src/sheets/window.js';
import { summarize, countSelfCheckout, averagePriorDays, countCohortStudents } from '../src/sheets/aggregate.js';
import { formatReport } from '../src/sheets/report.js';
import { COL, SETTEO } from '../src/sheets/columns.js';

// ─── parseSubmittedAt ─────────────────────────────────────────────────────────

test('parseSubmittedAt entiende D/M/YYYY H:MM:SS (día primero) y ajusta GMT-2 → Bogotá', () => {
  // 9 de junio (no 6 de septiembre), y 17:03 GMT-2 = 14:03 Bogotá (−3h).
  const ms = parseSubmittedAt('9/6/2026 17:03:04');
  assert.equal(ms, Date.UTC(2026, 5, 9, 14, 3, 4));
});

test('parseSubmittedAt tolera medianoche y segundos opcionales (con ajuste −3h)', () => {
  assert.equal(parseSubmittedAt('10/6/2026 0:34:09'), Date.UTC(2026, 5, 9, 21, 34, 9));
  assert.equal(parseSubmittedAt('1/1/2026 8:05'), Date.UTC(2026, 0, 1, 5, 5, 0));
});

test('parseSubmittedAt: el desfase de zona es configurable (aheadHours=0 = sin ajuste)', () => {
  assert.equal(parseSubmittedAt('9/6/2026 17:03:04', 0), Date.UTC(2026, 5, 9, 17, 3, 4));
});

test('parseSubmittedAt devuelve null para encabezado o basura', () => {
  assert.equal(parseSubmittedAt('Submitted At'), null);
  assert.equal(parseSubmittedAt(''), null);
  assert.equal(parseSubmittedAt(null), null);
  assert.equal(parseSubmittedAt('2026-06-09T17:03:04Z'), null); // ISO no es el formato del Form
  assert.equal(parseSubmittedAt('32/1/2026 0:00:00'), null); // día inválido
});

// ─── computeWindow ────────────────────────────────────────────────────────────

test('computeWindow → [ayer 20:00, hoy 20:00) en hora de pared de Bogotá', () => {
  const now = new Date('2026-06-10T20:00:00-05:00'); // 10-jun 8:00pm Bogotá
  const { startMs, endMs } = computeWindow(now);
  assert.equal(endMs, Date.UTC(2026, 5, 10, 20, 0, 0));
  assert.equal(startMs, Date.UTC(2026, 5, 9, 20, 0, 0));
});

test('zonedParts ve la fecha local de Bogotá, no UTC', () => {
  // 11-jun 00:30 UTC es aún 10-jun 19:30 en Bogotá (UTC-5).
  const p = zonedParts(new Date('2026-06-11T00:30:00Z'));
  assert.equal(p.y, 2026);
  assert.equal(p.m, 6);
  assert.equal(p.d, 10);
  assert.equal(p.H, 19);
});

// ─── summarize ────────────────────────────────────────────────────────────────

// Construye una fila del tab de leads con sólo las columnas que importan.
function row({ submittedAt, momento = '', iaPrev = '', inversion = '', calendly = '' }) {
  const r = [];
  r[COL.submittedAt] = submittedAt;
  r[COL.momento] = momento;
  r[COL.iaPrev] = iaPrev;
  r[COL.inversion] = inversion;
  r[COL.calendly] = calendly;
  return r;
}

// Construye una fila del tab "Setteo Pendiente".
function setteoRow({ fecha, estadoPago = '' }) {
  const r = [];
  r[SETTEO.fecha] = fecha;
  r[SETTEO.estadoPago] = estadoPago;
  return r;
}

// Categorías auxiliares para probar la lógica de agrupación/% con independencia de
// la config de producción (que ya sólo lleva "inversión").
const GROUP_CATS = [
  { key: 'momento', col: COL.momento, label: 'Momento' },
  {
    key: 'iaPrev',
    col: COL.iaPrev,
    label: 'IA',
    normalize: (v) => (String(v).trim().toLowerCase() === 'true' ? 'Sí' : 'No'),
  },
];

const WIN = {
  startMs: Date.UTC(2026, 5, 9, 20, 0, 0),
  endMs: Date.UTC(2026, 5, 10, 20, 0, 0),
};

test('summarize cuenta sólo las filas dentro de la ventana (bordes incluidos, hora origen GMT-2)', () => {
  // Las marcas vienen en GMT-2; tras −3h se comparan contra la ventana de Bogotá.
  const rows = [
    ['Submitted At'], // encabezado → fuera
    row({ submittedAt: '9/6/2026 22:59:59' }), // → 19:59:59 Bogotá → antes del inicio → fuera
    row({ submittedAt: '9/6/2026 23:00:00' }), // → 20:00:00 Bogotá → inicio inclusivo → dentro
    row({ submittedAt: '10/6/2026 3:34:09' }), // → 0:34:09 Bogotá → dentro
    row({ submittedAt: '10/6/2026 23:00:00' }), // → 20:00:00 Bogotá → fin exclusivo → fuera
  ];
  const s = summarize(rows, WIN);
  assert.equal(s.total, 2);
});

test('summarize agrupa por categoría y saca % sobre los NO vacíos', () => {
  const rows = [
    row({ submittedAt: '10/6/2026 9:00:00', momento: 'Abogado Jr.', iaPrev: 'TRUE' }),
    row({ submittedAt: '10/6/2026 10:00:00', momento: 'Abogado Jr.', iaPrev: 'FALSE' }),
    row({ submittedAt: '10/6/2026 11:00:00', momento: 'Litigante', iaPrev: '' }),
  ];
  const s = summarize(rows, WIN, GROUP_CATS);
  assert.equal(s.total, 3);

  const momento = s.breakdown.find((b) => b.key === 'momento');
  assert.equal(momento.answered, 3);
  assert.deepEqual(
    momento.items.map((i) => [i.value, i.count, i.pct]),
    [['Abogado Jr.', 2, 67], ['Litigante', 1, 33]]
  );

  // iaPrev: sólo 2 respondieron (uno vacío) → % sobre 2, y TRUE/FALSE → Sí/No.
  const ia = s.breakdown.find((b) => b.key === 'iaPrev');
  assert.equal(ia.answered, 2);
  assert.deepEqual(
    ia.items.map((i) => [i.value, i.count, i.pct]).sort(),
    [['No', 1, 50], ['Sí', 1, 50]]
  );
});

test('summarize: el desglose por defecto es SÓLO la inversión, con rótulo $1000', () => {
  const rows = [
    row({ submittedAt: '10/6/2026 9:00:00', inversion: 'Sí.' }),
    row({ submittedAt: '10/6/2026 10:00:00', inversion: 'No. Es imposible para mi invertir ese monto.' }),
    row({ submittedAt: '10/6/2026 11:00:00', inversion: 'Sí pero financiado.' }),
  ];
  const s = summarize(rows, WIN);
  assert.deepEqual(
    s.breakdown.map((b) => b.key),
    ['inversion']
  );
  const inv = s.breakdown[0];
  assert.match(inv.label, /\$1000 USD/);
  assert.equal(inv.answered, 3);
  assert.deepEqual(
    inv.items.map((i) => i.value).sort(),
    ['No', 'Sí', 'Sí (financiado)']
  );
});

test('summarize cuenta los bookings de Calendly (col I no vacía en la ventana)', () => {
  const rows = [
    row({ submittedAt: '10/6/2026 9:00:00', calendly: 'https://calendly.com/d/abc/invitees/1' }),
    row({ submittedAt: '10/6/2026 10:00:00', calendly: '' }),
    row({ submittedAt: '10/6/2026 11:00:00', calendly: 'https://calendly.com/d/abc/invitees/2' }),
    // Fuera de la ventana (fin exclusivo) → no cuenta aunque tenga Calendly.
    row({ submittedAt: '10/6/2026 23:00:00', calendly: 'https://calendly.com/d/abc/invitees/3' }),
  ];
  const s = summarize(rows, WIN);
  assert.equal(s.calendlyBooked, 2);
});

// ─── countSelfCheckout ────────────────────────────────────────────────────────

test('countSelfCheckout: reached = todos los del pipeline en ventana; paid = sólo los "Self-checkout"', () => {
  const rows = [
    ['Fecha detección'], // encabezado → fuera (no parsea fecha)
    setteoRow({ fecha: '10/06/2026 8:15', estadoPago: '💳 Self-checkout' }), // dentro → reached + paid
    setteoRow({ fecha: '10/06/2026 9:10', estadoPago: 'No hizo self-checkout' }), // dentro → reached (no pagó)
    setteoRow({ fecha: '10/06/2026 12:09', estadoPago: '💳 Self-checkout' }), // dentro → reached + paid
    setteoRow({ fecha: '9/6/2026 8:15', estadoPago: '💳 Self-checkout' }), // 9-jun 8:15am < inicio → fuera
    setteoRow({ fecha: '10/06/2026 20:00', estadoPago: '💳 Self-checkout' }), // fin exclusivo → fuera
    setteoRow({ fecha: '10/06/2026 10:00', estadoPago: '' }), // sin estado → no es entrada del pipeline
  ];
  assert.deepEqual(countSelfCheckout(rows, WIN), { reached: 3, paid: 2 });
});

// ─── averagePriorDays ─────────────────────────────────────────────────────────

test('averagePriorDays promedia los 7 días previos y EXCLUYE el día de hoy', () => {
  const now = new Date('2026-06-10T20:00:00-05:00'); // corte de hoy 10-jun 8pm Bogotá
  const rows = [
    // HOY (ventana 9/6 8pm → 10/6 8pm) → NO debe entrar al promedio previo.
    row({ submittedAt: '10/6/2026 13:00:00', calendly: 'https://calendly.com/x/invitees/hoy' }),
    row({ submittedAt: '10/6/2026 13:30:00' }),
    row({ submittedAt: '10/6/2026 14:00:00' }),
    // Día -1 (ventana cierra 9/6 8pm): 1 entrada, con Calendly.
    row({ submittedAt: '9/6/2026 13:00:00', calendly: 'https://calendly.com/x/invitees/d1' }),
    // Día -2 (ventana cierra 8/6 8pm): 2 entradas.
    row({ submittedAt: '8/6/2026 13:00:00' }),
    row({ submittedAt: '8/6/2026 14:00:00' }),
  ];
  const setteoRows = [
    setteoRow({ fecha: '10/06/2026 10:00', estadoPago: '💳 Self-checkout' }), // hoy → excluido
    setteoRow({ fecha: '8/06/2026 10:00', estadoPago: '💳 Self-checkout' }), // día -2 → cuenta
  ];

  const avg = averagePriorDays(rows, setteoRows, now, 7);
  assert.equal(avg.days, 7);
  // prev total = 1 (d-1) + 2 (d-2) = 3 sobre 7 → 0.4 (si colara hoy, sería 1.1)
  assert.equal(avg.total.toFixed(1), '0.4');
  assert.equal(avg.calendly.toFixed(1), '0.1'); // 1 booking previo / 7
  assert.equal(avg.reached.toFixed(1), '0.1'); // 1 self-checkout previo / 7
  assert.equal(avg.paid.toFixed(1), '0.1');
});

// ─── formatReport ─────────────────────────────────────────────────────────────

test('formatReport arma el mensaje con total, funnel e inversión (sin momento/IA, sin PII)', () => {
  const rows = [
    row({ submittedAt: '10/6/2026 9:00:00', inversion: 'Sí.', calendly: 'https://calendly.com/x/invitees/1' }),
  ];
  const summary = { ...summarize(rows, WIN), selfCheckout: { reached: 7, paid: 3 } };
  const msg = formatReport(summary, WIN);
  assert.match(msg, /Reporte de leads/);
  assert.match(msg, /9\/6 8:00pm → 10\/6 8:00pm/);
  assert.match(msg, /Total de entradas: 1/);
  // Funnel: Calendly + self-checkout (llegaron + pagaron).
  assert.match(msg, /Bookearon Calendly: 1/);
  assert.match(msg, /Llegaron al self-checkout: 7 \(pagaron: 3\)/);
  // Inversión con el rótulo $1000 (la columna sigue siendo la de $1200).
  assert.match(msg, /Dispuesto a invertir \(\$1000 USD\)/);
  assert.match(msg, /Sí: 1 \(100%\)/);
  // Momento profesional y experiencia con IA NO entran al reporte automático.
  assert.doesNotMatch(msg, /Momento profesional/);
  assert.doesNotMatch(msg, /Experiencia previa con IA/);
  // Sin PII: no debe haber correos ni teléfonos.
  assert.doesNotMatch(msg, /@|\+?\d{7,}/);
});

test('formatReport ya NO muestra el prom. 7d aunque el summary traiga avg7 (pedido 2026-07-09)', () => {
  const summary = {
    total: 26,
    calendlyBooked: 4,
    selfCheckout: { reached: 7, paid: 0 },
    breakdown: [],
    avg7: { days: 7, total: 22.4, calendly: 4.9, reached: 6.0, paid: 1.3 },
  };
  const msg = formatReport(summary, WIN);
  assert.match(msg, /Total de entradas: 26$/m);
  assert.match(msg, /Bookearon Calendly: 4$/m);
  assert.match(msg, /Llegaron al self-checkout: 7 \(pagaron: 0\)$/m);
  assert.doesNotMatch(msg, /prom\. 7d/);
});

test('formatReport con ventana vacía dice que no llegaron postulaciones', () => {
  const msg = formatReport(summarize([], WIN), WIN);
  assert.match(msg, /Total de entradas: 0/);
  assert.match(msg, /No llegaron postulaciones/);
});

// ─── countCohortStudents ──────────────────────────────────────────────────────

test('countCohortStudents cuenta filas con nombre y salta encabezado + plantilla', () => {
  const rows = [
    ['¿Cuál es tu nombre completo?', '¿Cuál es tu telefono?', 'Closer'], // encabezado
    ['Ana Pérez', '300...', 'Sebas R'],
    ['Luis Gómez', '', ''], // nombre presente aunque falte precio/closer → cuenta
    ['', '', 'Pendiente'], // fila plantilla sin nombre → NO cuenta
    ['  ', '', ''], // solo espacios → NO cuenta
  ];
  assert.equal(countCohortStudents(rows), 2);
});

test('countCohortStudents tolera vacío y filas cortas', () => {
  assert.equal(countCohortStudents([]), 0);
  assert.equal(countCohortStudents(null), 0);
  assert.equal(countCohortStudents([['header']]), 0); // solo encabezado
});
