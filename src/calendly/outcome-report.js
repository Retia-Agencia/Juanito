// src/calendly/outcome-report.js
// PURO (sin red, sin DB → testeable en Windows). Agrega y formatea el reporte de
// outcomes post-call (§18.AB): por programa → por closer, con ranking de cumplimiento.
//
// El reporte de métricas existente (sheets/metrics.js) lee una hoja llenada a mano;
// ESTE sale directo de `call_outcomes` (lo que el closer confirmó por WhatsApp), así
// que es la métrica confiable. Se entrega a los mismos grupos por programa.
//
// REGLA DE CONTEO (§18.AC): una call reagendada o cancelada NO ocurrió — no suma al
// volumen. Va a "movidas" y la call cuenta el día que de verdad se resolvió (la reagendada
// tiene su propia fila, con su propio show/no-show). Sin esto el mismo lead contaba dos
// veces: Calendly, al reagendar, cancela el evento viejo y crea uno nuevo con otro uuid.

import { ASISTENCIA_LABELS, RESULTADO_LABELS, formatCallDateTime } from './index.js';

// Clave de programa (en la DB) → nombre de sección (igual al del reporte de métricas).
// OJO: el reporte al grupo solo publica las secciones que `metrics-targets.js` sabe enrutar
// (hoy: las 3 originales, cada una con su grupo en el .env). Los programas nuevos SÍ quedan
// registrados en `call_outcomes` y sus closers reciben el Push 4; lo que falta para que
// aparezcan en el reporte publicado es un grupo destino. Ver §18.AE del handoff.
export const PROGRAM_TO_COMPANY = {
  second_brain: 'AI SECOND BRAIN',
  abogados: 'ESTADOX',
  linkedin: 'LINKEDIN SALES',
  developers: 'AI FOR DEVELOPERS',
  operaciones: 'OPERACIONES ESCALABLES',
};

// Estados que sacan la call del volumen: no ocurrió.
const MOVIDA = new Set(['reagendado', 'cancelado']);

function pct(num, den) {
  if (!den) return 0;
  return Math.round((num / den) * 100);
}

// Agrega filas crudas de call_outcomes → { [program]: { [closer]: stats } }.
// stats: total (= show + no_show + sin_registrar), registrados, sin_registrar,
//        show, no_show, reagendado, cancelado, movidas, destinos[],
//        venta_cerrada, acuerdo_verbal, seguimiento, no_cerro,
//        show_rate, close_rate, cumplimiento.
export function aggregateOutcomes(rows = []) {
  const byProgram = {};
  for (const r of rows) {
    const prog = r.program || 'desconocido';
    const closer = r.closer_name || r.closer_email || 'sin closer';
    byProgram[prog] ??= {};
    const s = (byProgram[prog][closer] ??= {
      total: 0, registrados: 0, sin_registrar: 0,
      show: 0, no_show: 0, reagendado: 0, cancelado: 0, movidas: 0, destinos: [],
      venta_cerrada: 0, acuerdo_verbal: 0, seguimiento: 0, no_cerro: 0,
    });

    // Movidas: fuera del volumen (ni total, ni registrados, ni sin_registrar). Contarlas
    // en `total` es exactamente el doble conteo que este reporte tenía.
    if (MOVIDA.has(r.asistencia)) {
      s[r.asistencia]++;
      s.movidas++;
      if (r.asistencia === 'reagendado' && r.rescheduled_to) {
        s.destinos.push({ lead: r.lead_name || null, to: r.rescheduled_to });
      }
      continue;
    }

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
      const decididas = s.show + s.no_show; // base del show rate
      s.show_rate = pct(s.show, decididas);
      s.close_rate = pct(s.venta_cerrada, s.show);
      s.cumplimiento = pct(s.registrados, s.total);
    }
  }
  return byProgram;
}

// Primer nombre + inicial ("Pablo G.") para la línea compacta de reagendas.
function shortLead(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'un lead';
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[1][0].toUpperCase()}.`;
}

// Formatea la sección de UN programa para su grupo de WhatsApp. `closers` es el
// sub-objeto de aggregateOutcomes para ese programa (o vacío). `dateLabel` es un
// texto legible del día. Devuelve el mensaje, o null si no hay nada que reportar.
export function formatOutcomeSection(programKey, closers = {}, { dateLabel = 'hoy', tz } = {}) {
  const company = PROGRAM_TO_COMPANY[programKey] || programKey;
  const names = Object.keys(closers);
  if (!names.length) return null;

  // Ranking: primero por cumplimiento desc, luego por más calls.
  names.sort((a, b) => closers[b].cumplimiento - closers[a].cumplimiento || closers[b].total - closers[a].total);

  let totCalls = 0, totReg = 0, totShow = 0, totDec = 0, totVenta = 0;
  let totReag = 0, totCancel = 0;
  const destinos = [];

  const blocks = names.map((name) => {
    const s = closers[name];
    totCalls += s.total; totReg += s.registrados; totShow += s.show;
    totDec += s.show + s.no_show; totVenta += s.venta_cerrada;
    totReag += s.reagendado; totCancel += s.cancelado;
    destinos.push(...s.destinos);

    const falta = s.sin_registrar ? `  ⚠️ ${s.sin_registrar} sin registrar` : '';
    const detalle = [
      s.show ? `${s.show} ${ASISTENCIA_LABELS.show}` : null,
      s.no_show ? `${s.no_show} ${ASISTENCIA_LABELS.no_show}` : null,
    ].filter(Boolean).join(' · ');
    const movidas = s.movidas
      ? `  🔁 ${[
          s.reagendado ? `${s.reagendado} reagendada${s.reagendado === 1 ? '' : 's'}` : null,
          s.cancelado ? `${s.cancelado} cancelada${s.cancelado === 1 ? '' : 's'}` : null,
        ].filter(Boolean).join(' · ')}`
      : '';
    const ventas = s.venta_cerrada
      ? `\n   💰 ${s.venta_cerrada} ${RESULTADO_LABELS.venta_cerrada} (close ${s.close_rate}%)`
      : '';
    return (
      `• *${name}* — ${s.total} call${s.total === 1 ? '' : 's'} · ✅ ${s.cumplimiento}% registrado${falta}\n` +
      `   ${detalle || 'sin estados'} — show ${s.show_rate}%${movidas}${ventas}`
    );
  });

  const cumpl = pct(totReg, totCalls);
  const showRate = pct(totShow, totDec);

  // Línea de movidas: las calls que NO ocurrieron (no cuentan en el volumen de arriba).
  const movidasLine = totReag + totCancel
    ? `\n🔁 movidas: ${[
        totReag ? `${totReag} reagendada${totReag === 1 ? '' : 's'}` : null,
        totCancel ? `${totCancel} cancelada${totCancel === 1 ? '' : 's'}` : null,
      ].filter(Boolean).join(' · ')}`
    : '';
  // A dónde se movieron las reagendadas con fecha (las que Juanito ya tiene agendadas).
  const destinosLine = destinos.length
    ? `\n   ${destinos
        .map((x) => `${shortLead(x.lead)} → ${formatCallDateTime(`${x.to.replace(' ', 'T')}Z`, tz)}`)
        .join(' · ')}`
    : '';

  return (
    `📋 *Registro de calls — ${company}* (${dateLabel})\n` +
    `${totCalls} call${totCalls === 1 ? '' : 's'} · ${cumpl}% registradas · show ${showRate}% · ${totVenta} venta${totVenta === 1 ? '' : 's'}` +
    movidasLine + destinosLine + `\n\n` +
    blocks.join('\n') +
    (cumpl < 100 ? `\n\n_Las calls sin registrar no cuentan en las métricas — recuerden cerrarlas con Juanito._` : '')
  );
}
