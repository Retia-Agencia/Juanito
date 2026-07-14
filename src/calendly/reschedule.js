// src/calendly/reschedule.js
// EFECTO de una reagenda (§18.AC): escribe las filas que planea reschedule-logic.js.
//
// La idea: no hace falta ninguna tabla ni "memoria" nueva. Una fila de calendly_pushes con
// un event_uuid sintético ('manual:<uuid>:<n>') ES la memoria, y la maquinaria que ya existe
// hace el resto — el cron de entrega la dispara a la hora nueva con todos los gates
// anti-ban, y la limpieza de las 3am la purga sola. Esto es lo que hace que las reagendas
// POR FUERA de Calendly (otro link, coordinadas por WhatsApp) entren igual a las métricas:
// el poll nunca las vería.
//
// Si la reagenda sí vuelve a entrar por Calendly, el poll la detecta y cancela estos pushes
// sintéticos (supersedeManualPushes) → nunca se pregunta ni se cuenta dos veces.

import { planRescheduledPushes } from './reschedule-logic.js';
import { scheduleCalendlyPush } from '../db/index.js';

const LEAD_MIN = () => Number(process.env.CALENDLY_PUSH3_LEAD_MIN || 25);
const CALL_DURATION_MIN = () => Number(process.env.CALENDLY_CALL_DURATION_MIN || 30);
const PUSH4_GRACE_MIN = () => Number(process.env.CALENDLY_PUSH4_GRACE_MIN || 5);
const MAX_CHAIN = () => Number(process.env.CALENDLY_RESCHEDULE_MAX_CHAIN || 3);

// Devuelve { ok, uuid, depth, scheduled: ['push3','push4'] } o { ok: false, reason: 'chain' }.
export function createRescheduledCall(outcome, startUtc, { nowMs = Date.now() } = {}) {
  const plan = planRescheduledPushes(outcome, startUtc, {
    nowMs,
    leadMin: LEAD_MIN(),
    durationMin: CALL_DURATION_MIN(),
    graceMin: PUSH4_GRACE_MIN(),
    maxChain: MAX_CHAIN(),
  });
  if (!plan.ok) return plan;

  const scheduled = [];
  for (const push of plan.pushes) {
    scheduleCalendlyPush(push);
    scheduled.push(`push${push.push_n}`);
  }
  return { ok: true, uuid: plan.uuid, depth: plan.depth, scheduled };
}
