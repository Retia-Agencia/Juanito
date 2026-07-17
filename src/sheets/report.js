// src/sheets/report.js
// PURO. Formatea el reporte diario de leads para WhatsApp. SIN PII (sólo conteos y
// porcentajes por categoría). Recibe el `summary` de aggregate.js y, opcionalmente,
// la ventana para rotular el periodo.

// Los límites de la ventana son epoch "naive" (hora de pared de Bogotá), así que
// getUTC* recupera justo los componentes de Bogotá sin re-aplicar zona.
function dm(ms) {
  const dt = new Date(ms);
  return `${dt.getUTCDate()}/${dt.getUTCMonth() + 1}`;
}

const DAY_MS = 24 * 3600 * 1000;
const DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const dow = (ms) => DOW[new Date(ms).getUTCDay()];

// Debajo de esta tasa diaria NO se muestra el % de cambio: en números chicos un
// 0.1→0.2 se leería como "+100%" (ruido), y una base 0 haría div/0. Se muestra
// solo el valor. (redesign 2026-07-17)
const PCT_MIN_BASE = 1.0;

// Bloque de tendencia semanal (§18.B, redesign 2026-07-17). Recibe el resultado de
// buildWeeklySections (weekly.js). UN solo bloque compacto (antes eran dos secciones
// que duplicaban la semana pasada), todo en PROMEDIO DIARIO, like-for-like: cada
// semana medida lun → el MISMO corte de hoy (parciales de weekly.js), así el "en
// curso" se compara contra tramos iguales, no contra semanas completas.
//
// Etiquetas RELATIVAS (week, week-1…), nuevo→viejo. Cada métrica trae el % de cambio
// vs la semana inmediatamente anterior (la de abajo), sobre las tasas YA redondeadas
// para que el % cuadre con lo que se ve. Viñetas por línea (las tablas alineadas se
// rompen en WhatsApp móvil).
//
// Pagos partidos en dos: 💳 auto (checkout automático / self-checkout) y 📞 call
// (cerrado en llamada = total Stripe − auto). Sin Stripe no hay total → `call` sale
// n/d y solo se muestra `auto` (del tag del Sheet).
export function formatWeeklySections(weekly) {
  if (!weekly) return '';
  const { partialWeeks, historyOk, paymentsSource } = weekly;
  const hasStripe = paymentsSource === 'stripe';

  const days = (win) => (win.endMs - win.startMs) / DAY_MS;
  const d1 = (n) => n.toFixed(1);
  // Tasas diarias de una ventana (redondeadas a 1 decimal). `call` puede ser null.
  const rates = (m, win) => ({
    leads: d1(m.total / days(win)),
    cal: d1(m.calendly / days(win)),
    chk: d1(m.reached / days(win)),
    auto: d1(m.auto / days(win)),
    call: m.call != null ? d1(m.call / days(win)) : null,
  });

  // % de cambio vs la semana anterior, sobre las tasas redondeadas. Devuelve '' (sin
  // sufijo) cuando no hay base con qué comparar o la base es < PCT_MIN_BASE.
  const pct = (cur, prev) => {
    if (cur == null || prev == null) return '';
    const p = parseFloat(prev);
    if (!(p >= PCT_MIN_BASE)) return '';
    const r = Math.round(((parseFloat(cur) - p) / p) * 100);
    return ` (${r >= 0 ? '+' : ''}${r}%)`;
  };

  const cur = partialWeeks[0].win;
  const cutH = new Date(cur.endMs).getUTCHours();
  const cutLabel = cutH === 0 ? '12:00am' : `${cutH > 12 ? cutH - 12 : cutH}:00${cutH >= 12 ? 'pm' : 'am'}`;

  const lines = [
    '──────────',
    `📈 Tendencia semanal · promedio diario · lun → ${dow(cur.endMs)} ${cutLabel}`,
    '',
  ];

  // Índice 0 = semana en curso ("week"); k = "week-k". El % de cada fila compara
  // contra la de abajo (una semana más vieja); la más vieja no lleva %.
  for (let i = 0; i < partialWeeks.length; i++) {
    const r = rates(partialWeeks[i].metrics, partialWeeks[i].win);
    const older = partialWeeks[i + 1]
      ? rates(partialWeeks[i + 1].metrics, partialWeeks[i + 1].win)
      : null;
    const p = (key) => (older ? pct(r[key], older[key]) : '');
    const label = i === 0 ? 'week (en curso)' : `week-${i}`;
    const parts = [
      `${r.leads} leads${p('leads')}`,
      `${r.cal} cal${p('cal')}`,
      `${r.chk} chk${p('chk')}`,
      `💳 ${r.auto} auto${p('auto')}`,
    ];
    if (r.call != null) parts.push(`📞 ${r.call} call${p('call')}`);
    lines.push(`• ${label}: ${parts.join(' · ')}`);
  }

  lines.push('', '💳 auto = checkout automático · 📞 call = cerrado en llamada · (%) vs. semana anterior');
  if (!hasStripe) {
    lines.push('📞 call: n/d (Stripe no respondió) — 💳 auto sale del tag del Sheet');
  }
  lines.push(hasStripe ? 'Pagos: Stripe (solo conteo)' : 'Pagos: tag del Sheet');
  if (!historyOk) {
    lines.push('⚠️ El histórico del Sheet no cubre todas las semanas; los conteos viejos pueden quedar cortos.');
  }

  return lines.join('\n');
}

export function formatReport(summary, { startMs, endMs } = {}) {
  const lines = ['📊 Reporte de leads — IA para Abogados (EstadoX)'];

  if (startMs != null && endMs != null) {
    lines.push(`🗓️ ${dm(startMs)} 8:00pm → ${dm(endMs)} 8:00pm`);
  }

  lines.push('', `Total de entradas: ${summary.total}`);

  if (summary.total === 0) {
    lines.push('', 'No llegaron postulaciones en esta ventana.');
    // Pagos y comparativas semanales salen igual: no dependen de que hoy haya leads.
    if (summary.stripeToday != null) {
      lines.push(`💰 Pagos confirmados (Stripe): ${summary.stripeToday}`);
    }
    if (summary.weekly) lines.push('', formatWeeklySections(summary.weekly));
    return lines.join('\n');
  }

  // Métricas del funnel: conteos simples de la ventana del día. La comparación
  // histórica vive en el bloque semanal (pedido del owner 2026-07-09: sin prom. 7d).
  if (summary.calendlyBooked != null) {
    lines.push(`📅 Bookearon Calendly: ${summary.calendlyBooked}`);
  }
  if (summary.selfCheckout != null) {
    const { reached, paid } = summary.selfCheckout;
    lines.push(`💳 Llegaron al self-checkout: ${reached} (pagaron: ${paid})`);
  }
  // Pagos cobrados de verdad (PaymentIntents succeeded) — solo si Stripe respondió.
  if (summary.stripeToday != null) {
    lines.push(`💰 Pagos confirmados (Stripe): ${summary.stripeToday}`);
  }

  for (const cat of summary.breakdown) {
    lines.push('', `*${cat.label}* (${cat.answered} respondieron)`);
    if (!cat.items.length) {
      lines.push('  — sin datos');
      continue;
    }
    for (const it of cat.items) {
      lines.push(`  • ${it.value}: ${it.count} (${it.pct}%)`);
    }
  }

  if (summary.weekly) lines.push('', formatWeeklySections(summary.weekly));

  return lines.join('\n');
}
