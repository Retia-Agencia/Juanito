// src/scheduler/outcome-report.js
// Cron del reporte diario de "Registro de calls" (§18.AB). Lee call_outcomes (la fuente
// de verdad: lo que el closer confirmó por WhatsApp) y publica una sección por programa
// en su grupo — la misma separación programa→grupo que el reporte de métricas.
//
// A diferencia de sheets-metrics.js (que lee una hoja llenada a mano), esto sale directo
// de la DB, así que no depende de que nadie llene un spreadsheet.

import { CronJob } from 'cron';
import { sendMessage, resolveGroupByName } from '../whatsapp/index.js';
import { getOutcomesInWindow } from '../db/index.js';
import { aggregateOutcomes, formatOutcomeSection, PROGRAM_TO_COMPANY } from '../calendly/outcome-report.js';
import { dayRangeUtc } from '../calendly/index.js';
import { sectionTargets } from './metrics-targets.js';

const TZ = () => process.env.TZ || 'America/Bogota';
const CRON = () => process.env.OUTCOME_REPORT_CRON || '0 22 * * *';
// Toggle para no publicar el reporte al grupo (ej: durante un test acotado a un closer,
// donde no queremos que el grupo entero vea un "Registro de calls" con un solo nombre).
const REPORT_ENABLED = () => process.env.OUTCOME_REPORT_ENABLED !== 'false'; // default true

// Nombre de sección (company) → clave de programa (en la DB).
const COMPANY_TO_PROGRAM = Object.fromEntries(
  Object.entries(PROGRAM_TO_COMPANY).map(([prog, company]) => [company, prog])
);

// Un grupo puede venir como group_id (…@g.us) o como NOMBRE (se resuelve en runtime).
async function resolveTarget(t) {
  if (!t) return null;
  if (t.endsWith('@g.us')) return t;
  const g = await resolveGroupByName(t);
  return g?.id || null;
}

function dateLabel(now) {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: TZ(),
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(now);
}

// ISO 'YYYY-MM-DDTHH:MM:SS.sssZ' → 'YYYY-MM-DD HH:MM:SS' (formato UTC de call_start).
const toDbUtc = (iso) => iso.slice(0, 19).replace('T', ' ');

// Núcleo: arma una sección por programa con grupo configurado. Devuelve
// [{ company, group, program, message }]. Sin envío (testeable / preview).
export async function buildOutcomeReports({ now = new Date() } = {}) {
  const { minStartIso, maxStartIso } = dayRangeUtc(TZ(), 0, now);
  const rows = getOutcomesInWindow(toDbUtc(minStartIso), toDbUtc(maxStartIso));
  const agg = aggregateOutcomes(rows);
  const label = dateLabel(now);
  const out = [];
  for (const { company, group } of sectionTargets()) {
    const program = COMPANY_TO_PROGRAM[company];
    const message = formatOutcomeSection(program, agg[program] || {}, { dateLabel: label });
    if (message) out.push({ company, group, program, message });
  }
  return out;
}

export function startOutcomeReportJob() {
  if (!REPORT_ENABLED()) {
    console.log('[Outcomes] reporte de calls al grupo DESACTIVADO (OUTCOME_REPORT_ENABLED=false)');
    return;
  }
  const targets = sectionTargets();
  if (!targets.length) {
    console.warn('[Outcomes] sin grupos por sección (SHEETS_METRICS_*_GROUP) → reporte de calls desactivado');
    return;
  }
  new CronJob(
    CRON(),
    async () => {
      try {
        const reports = await buildOutcomeReports({});
        for (const r of reports) {
          const target = await resolveTarget(r.group);
          if (!target) {
            console.error(`[Outcomes] no pude resolver el grupo "${r.group}" para ${r.company} (¿Juanito está en el grupo?)`);
            continue;
          }
          await sendMessage(target, r.message).catch((e) =>
            console.error(`[Outcomes] envío ${r.company} → ${r.group}:`, e.message)
          );
        }
        console.log(`[Outcomes] Reporte de calls enviado (${reports.length} sección/es con datos)`);
      } catch (e) {
        console.error('[Outcomes] error en el reporte de calls:', e.message);
      }
    },
    null,
    true,
    TZ()
  );
  console.log(`[Outcomes] Job de reporte de calls activo ✅ (cron "${CRON()}", ${targets.length} grupo/s)`);
}
