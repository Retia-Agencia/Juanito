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

  return lines.join('\n');
}
