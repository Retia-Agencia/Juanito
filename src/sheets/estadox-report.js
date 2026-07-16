// src/sheets/estadox-report.js
// PURO. Formatea el reporte admin de EstadoX para Mariana Cerón (§18.AD). Es un
// mensaje DISTINTO al reporte estándar de leads: cinco métricas que ella pidió
// (2026-07-15). Sin PII — solo conteos.
//
// Recibe un objeto `data` ya agregado (lo arma el builder en scheduler/sheets-report.js)
// y la ventana [ayer 20:00, hoy 20:00) para rotular el periodo. Los límites de la
// ventana son epoch "naive" (hora de pared de Bogotá) → getUTC* recupera los
// componentes de Bogotá sin re-aplicar zona.

function dm(ms) {
  const dt = new Date(ms);
  return `${dt.getUTCDate()}/${dt.getUTCMonth() + 1}`;
}

// data = {
//   total,        // typeforms diligenciados en la ventana
//   avg30,        // promedio diario de typeforms de los 30 días previos (sin hoy)
//   inv,          // { si, siFin, no } — desglose de "dispuesto a invertir"
//   agendadas,    // llamadas nuevas agendadas (leads de hoy que reservaron Calendly)
//   efectivas,    // llamadas efectivas del día (Show en el Push 4, programa abogados)
//   scPaid,       // pagos por self-checkout
//   stripeToday,  // total de pagos Stripe del día (null si Stripe no respondió)
// }
export function formatEstadoxAdminReport(data, { startMs, endMs } = {}) {
  const lines = ['📊 Reporte EstadoX — IA para Abogados'];

  if (startMs != null && endMs != null) {
    lines.push(`🗓️ ${dm(startMs)} 8:00pm → ${dm(endMs)} 8:00pm`);
  }

  // 1) Typeforms del día vs. promedio diario de los últimos 30 días.
  const avg = Number.isFinite(data.avg30) ? data.avg30.toFixed(1) : '0.0';
  lines.push('', `📝 Typeforms hoy: ${data.total} (prom. 30d: ${avg}/día)`);

  // 2) Desglose sí / sí financiado / no.
  const inv = data.inv || { si: 0, siFin: 0, no: 0 };
  lines.push(
    `   • Sí: ${inv.si}`,
    `   • Sí (financiado): ${inv.siFin}`,
    `   • No: ${inv.no}`
  );

  // 3) Llamadas agendadas vs. efectivas del día.
  lines.push('', `📞 Llamadas — agendadas: ${data.agendadas} · efectivas: ${data.efectivas}`);

  // 4) y 5) Pagos: self-checkout vs. fuera de self-checkout.
  lines.push(`💳 Pagos self-checkout: ${data.scPaid}`);
  if (data.stripeToday == null) {
    lines.push('💰 Pagos fuera de self-checkout: n/d (Stripe no respondió)');
  } else {
    const fuera = Math.max(0, data.stripeToday - data.scPaid);
    lines.push(`💰 Pagos fuera de self-checkout: ${fuera}`);
  }

  return lines.join('\n');
}

// Del desglose de `summarize` (categoría "inversion") saca los tres conteos que
// muestra el reporte. Los valores vienen ya normalizados por columns.js
// ('Sí' | 'Sí (financiado)' | 'No'). Robusto ante categorías/valores ausentes.
export function invBreakdown(breakdown = []) {
  const cat = (breakdown || []).find((b) => b.key === 'inversion');
  const out = { si: 0, siFin: 0, no: 0 };
  if (!cat) return out;
  for (const it of cat.items || []) {
    if (it.value === 'Sí (financiado)') out.siFin = it.count;
    else if (it.value === 'Sí') out.si = it.count;
    else if (it.value === 'No') out.no = it.count;
  }
  return out;
}
