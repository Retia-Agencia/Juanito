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
const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);

// Bloque de comparativas semanales (§18.B). Recibe el resultado de
// buildWeeklySections (weekly.js). Viñetas por línea (las tablas alineadas se
// rompen en WhatsApp móvil), orden viejo→nuevo, deltas absolutos con signo.
export function formatWeeklySections(weekly) {
  if (!weekly) return '';
  const { lastWeek, partialWeeks, historyOk, paymentsSource } = weekly;
  // Pagos: Stripe si hay dato; si no, el tag manual del Sheet.
  const pay = (m) => (m.payments != null ? m.payments : m.paid);

  const lines = ['──────────'];

  const lw = lastWeek.metrics;
  const pv = lastWeek.prev.metrics;
  const delta = (a, b) => `(ant: ${b}, ${signed(a - b)})`;
  lines.push(
    `📅 Semana pasada (lun ${dm(lastWeek.win.startMs)} → dom ${dm(lastWeek.win.endMs - DAY_MS)})`,
    `• Leads: ${lw.total} ${delta(lw.total, pv.total)}`,
    `• Calendly: ${lw.calendly} ${delta(lw.calendly, pv.calendly)}`,
    `• Self-checkout: ${lw.reached} ${delta(lw.reached, pv.reached)}`,
    `• Pagos: ${pay(lw)} ${delta(pay(lw), pay(pv))}`
  );

  // Últimas N semanas, lunes → día/corte de hoy. partialWeeks viene con índice 0 =
  // semana en curso; se imprime viejo→nuevo para leer la tendencia.
  const cur = partialWeeks[0].win;
  const cutH = new Date(cur.endMs).getUTCHours();
  const cutLabel = cutH === 0 ? '12:00am' : `${cutH > 12 ? cutH - 12 : cutH}:00${cutH >= 12 ? 'pm' : 'am'}`;
  lines.push('', `📈 Últimas ${partialWeeks.length} semanas — lun → ${dow(cur.endMs)} ${cutLabel}`);
  for (let i = partialWeeks.length - 1; i >= 0; i--) {
    const { win, metrics: m } = partialWeeks[i];
    const enCurso = i === 0 ? ' (en curso)' : '';
    lines.push(
      `• ${dm(win.startMs)}${enCurso}: ${m.total} leads · ${m.calendly} cal · ${m.reached} checkout · ${pay(m)} pagos`
    );
  }

  lines.push(
    '',
    paymentsSource === 'stripe' ? 'Pagos: Stripe (solo conteo)' : 'Pagos: tag del Sheet'
  );
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

  // Promedio de los 7 días previos (sin hoy), 1 decimal, para comparar el dato del día.
  const a = summary.avg7;
  const d1 = (n) => n.toFixed(1);

  lines.push(
    '',
    `Total de entradas: ${summary.total}${a ? `  ·  prom. ${a.days}d: ${d1(a.total)}` : ''}`
  );

  if (summary.total === 0) {
    lines.push('', 'No llegaron postulaciones en esta ventana.');
    // Pagos y comparativas semanales salen igual: no dependen de que hoy haya leads.
    if (summary.stripeToday != null) {
      lines.push(`💰 Pagos confirmados (Stripe): ${summary.stripeToday}`);
    }
    if (summary.weekly) lines.push('', formatWeeklySections(summary.weekly));
    return lines.join('\n');
  }

  // Métricas del funnel (conteos simples sobre la ventana + promedio de comparación).
  if (summary.calendlyBooked != null) {
    lines.push(
      `📅 Bookearon Calendly: ${summary.calendlyBooked}${a ? `  ·  prom. ${a.days}d: ${d1(a.calendly)}` : ''}`
    );
  }
  if (summary.selfCheckout != null) {
    const { reached, paid } = summary.selfCheckout;
    const avg = a ? `  ·  prom. ${a.days}d: ${d1(a.reached)} (pagaron: ${d1(a.paid)})` : '';
    lines.push(`💳 Llegaron al self-checkout: ${reached} (pagaron: ${paid})${avg}`);
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
