// src/calendly/outcome-report.js
// PURO (sin red, sin DB → testeable en Windows). Agrega y formatea el reporte de
// outcomes post-call (§18.AB): por programa → por closer, con ranking de cumplimiento.
//
// El reporte de métricas existente (sheets/metrics.js) lee una hoja llenada a mano;
// ESTE sale directo de `call_outcomes` (lo que el closer confirmó por WhatsApp), así
// que es la métrica confiable. Se entrega a los mismos grupos por programa.

import { ASISTENCIA_LABELS, RESULTADO_LABELS } from './index.js';

// Clave de programa (en la DB) → nombre de sección (igual al del reporte de métricas).
export const PROGRAM_TO_COMPANY = {
  second_brain: 'AI SECOND BRAIN',
  abogados: 'ESTADOX',
  linkedin: 'LINKEDIN SALES',
};

function pct(num, den) {
  if (!den) return 0;
  return Math.round((num / den) * 100);
}

// Agrega filas crudas de call_outcomes → { [program]: { [closer]: stats } }.
// stats: total, registrados (answered+auto), sin_registrar (pending+no_answer),
//        show, no_show, reagendado, cancelado, venta_cerrada, acuerdo_verbal,
//        seguimiento, no_cerro, show_rate, close_rate, cumplimiento.
export function aggregateOutcomes(rows = []) {
  const byProgram = {};
  for (const r of rows) {
    const prog = r.program || 'desconocido';
    const closer = r.closer_name || r.closer_email || 'sin closer';
    byProgram[prog] ??= {};
    const s = (byProgram[prog][closer] ??= {
      total: 0, registrados: 0, sin_registrar: 0,
      show: 0, no_show: 0, reagendado: 0, cancelado: 0,
      venta_cerrada: 0, acuerdo_verbal: 0, seguimiento: 0, no_cerro: 0,
    });
    s.total++;
    const registrado = r.status === 'answered' || r.status === 'auto';
    if (registrado) s.registrados++;
    else s.sin_registrar++;
    if (r.asistencia && s[r.asistencia] != null) s[r.asistencia]++;
    if (r.resultado && s[r.resultado] != null) s[r.resultado]++;
  }
  // Derivados.
  for (const prog of Object.values(byProgram)) {
    for (const s of Object.values(prog)) {
      const decididas = s.show + s.no_show; // base del show rate (excluye reagendó/cancela)
      s.show_rate = pct(s.show, decididas);
      s.close_rate = pct(s.venta_cerrada, s.show);
      s.cumplimiento = pct(s.registrados, s.total);
    }
  }
  return byProgram;
}

// Formatea la sección de UN programa para su grupo de WhatsApp. `closers` es el
// sub-objeto de aggregateOutcomes para ese programa (o vacío). `dateLabel` es un
// texto legible del día. Devuelve el mensaje, o null si no hay nada que reportar.
export function formatOutcomeSection(programKey, closers = {}, { dateLabel = 'hoy' } = {}) {
  const company = PROGRAM_TO_COMPANY[programKey] || programKey;
  const names = Object.keys(closers);
  if (!names.length) return null;

  // Ranking: primero por cumplimiento desc, luego por más calls.
  names.sort((a, b) => closers[b].cumplimiento - closers[a].cumplimiento || closers[b].total - closers[a].total);

  let totCalls = 0, totReg = 0, totShow = 0, totDec = 0, totVenta = 0;
  const blocks = names.map((name) => {
    const s = closers[name];
    totCalls += s.total; totReg += s.registrados; totShow += s.show;
    totDec += s.show + s.no_show; totVenta += s.venta_cerrada;
    const falta = s.sin_registrar ? `  ⚠️ ${s.sin_registrar} sin registrar` : '';
    const detalle = [
      s.show ? `${s.show} ${ASISTENCIA_LABELS.show}` : null,
      s.no_show ? `${s.no_show} ${ASISTENCIA_LABELS.no_show}` : null,
      s.reagendado ? `${s.reagendado} ${ASISTENCIA_LABELS.reagendado}` : null,
      s.cancelado ? `${s.cancelado} ${ASISTENCIA_LABELS.cancelado}` : null,
    ].filter(Boolean).join(' · ');
    const ventas = s.venta_cerrada
      ? `\n   💰 ${s.venta_cerrada} ${RESULTADO_LABELS.venta_cerrada} (close ${s.close_rate}%)`
      : '';
    return (
      `• *${name}* — ${s.total} call${s.total === 1 ? '' : 's'} · ✅ ${s.cumplimiento}% registrado${falta}\n` +
      `   ${detalle || 'sin estados'} — show ${s.show_rate}%${ventas}`
    );
  });

  const cumpl = pct(totReg, totCalls);
  const showRate = pct(totShow, totDec);
  return (
    `📋 *Registro de calls — ${company}* (${dateLabel})\n` +
    `${totCalls} calls · ${cumpl}% registradas · show ${showRate}% · ${totVenta} venta${totVenta === 1 ? '' : 's'}\n\n` +
    blocks.join('\n') +
    (cumpl < 100 ? `\n\n_Las calls sin registrar no cuentan en las métricas — recuerden cerrarlas con Juanito._` : '')
  );
}
