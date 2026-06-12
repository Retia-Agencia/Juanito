// src/scheduler/summaries.js
// Cron de resumen periódico de grupos del jefe.
// Lo expone el Track B; el Track A lo importa desde scheduler/index.js.
// Persiste con saveSummary({chatId,chatName,summary,periodStart,periodEnd}).

import { CronJob } from 'cron';
import { saveSummary, isGroupAuthorized } from '../db/index.js';
import { listGroups, getRecentMessages } from '../whatsapp/index.js';
import { summarizeGroupMessages } from '../claude/index.js';

const TZ = () => process.env.TZ || 'America/Bogota';
const MAX_GROUPS = () => Number(process.env.MAX_GROUPS_PER_CYCLE || 10);
const SUMMARY_CRON = () => process.env.SUMMARY_CRON || '0 */4 * * *'; // cada 4 horas
const CYCLE_HOURS = () => Number(process.env.SUMMARY_CYCLE_HOURS || 4);
// Tope duro de mensajes por resumen (un grupo de 300 puede generar miles en 4h).
const SUMMARY_MAX_MSGS = () => Number(process.env.SUMMARY_MAX_MSGS || 400);

function fmt(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`;
}

// ─── Una pasada de resumen (exportada para tests / disparo manual) ────────────

export async function runGroupSummaryCycle() {
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - CYCLE_HOURS() * 60 * 60 * 1000);

  let summarized = 0;
  try {
    // Solo resumir grupos autorizados (default-deny anti-secuestro): no procesar
    // ni almacenar resúmenes de grupos a los que nos metieron sin permiso.
    const groups = (await listGroups()).filter((g) => isGroupAuthorized(g.id));

    for (const group of groups.slice(0, MAX_GROUPS())) {
      try {
        // Ventana por TIEMPO real (las últimas CYCLE_HOURS), con tope duro — antes
        // leía "últimos 50" y el "resumen de 4h" cubría minutos en un grupo activo.
        const cap = SUMMARY_MAX_MSGS();
        const messages = await getRecentMessages(group.id, cap, CYCLE_HOURS());
        if (!messages.length) continue;

        let formatted = messages
          .filter((m) => m.body)
          .map((m) => `${m.sender?.pushname || m.sender?.id || '?'}: ${m.body}`)
          .join('\n');

        if (!formatted.trim()) continue;
        if (messages.length >= cap) {
          formatted = `(ventana truncada a los últimos ${cap} mensajes del período)\n${formatted}`;
        }

        const summary = await summarizeGroupMessages(group.name || group.id, formatted);

        saveSummary({
          chatId: group.id,
          chatName: group.name || group.id,
          summary,
          periodStart: fmt(periodStart),
          periodEnd: fmt(periodEnd),
        });

        summarized++;
        console.log(`[Scheduler] Grupo resumido: ${group.name || group.id}`);
      } catch (err) {
        console.error(`[Scheduler] Error resumiendo grupo ${group.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Scheduler] Error listando grupos:', err.message);
  }

  return summarized;
}

// ─── Job: resumir grupos periódicamente ───────────────────────────────────────

export function startGroupSummaryJob() {
  new CronJob(
    SUMMARY_CRON(),
    async () => {
      console.log('[Scheduler] Resumiendo grupos del jefe...');
      await runGroupSummaryCycle();
    },
    null,
    true,
    TZ()
  );

  console.log('[Scheduler] Job de resumen de grupos activo ✅');
}
