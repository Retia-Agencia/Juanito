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
//
// ⚠️ Ese supersede solo corre desde el poll de CALENDLY, así que no cubre el cruce inverso: la
// cita real que aparece por HubSpot. Y el orden real de los hechos es justo ese (§18.AU) — el
// poll del CRM ve el meeting primero y el closer dicta la reagenda minutos después. Caso medido:
// `hubspot:113752024882` creado 16:56 y `manual:b9bd368b…:1` a las 17:00, mismo closer y mismo
// minuto de arranque, ambos vivos → una call contada dos veces y dos pushes al mismo closer.
// Por eso el chequeo del slot vive ACÁ, antes de escribir: es el único punto por el que pasan
// todas las reagendas dictadas, venga la cita real de donde venga.

import { planRescheduledPushes } from './reschedule-logic.js';
import { scheduleCalendlyPush, findLiveCallAtSlot } from '../db/index.js';

const LEAD_MIN = () => Number(process.env.CALENDLY_PUSH3_LEAD_MIN || 25);
const CALL_DURATION_MIN = () => Number(process.env.CALENDLY_CALL_DURATION_MIN || 30);
const PUSH4_GRACE_MIN = () => Number(process.env.CALENDLY_PUSH4_GRACE_MIN || 5);
const MAX_CHAIN = () => Number(process.env.CALENDLY_RESCHEDULE_MAX_CHAIN || 3);

// Devuelve { ok, uuid, depth, scheduled: ['push3','push4'] } o { ok: false, reason: 'chain' }.
// Cuando esa call ya existía devuelve `{ ok: true, uuid: <uuid real>, scheduled: [], adopted: true }`:
// no se escribe nada y el outcome queda apuntando al evento real, que es el de mejor procedencia
// (trae contacto y programa del CRM/Calendly, no del dictado). Para el closer el efecto es el
// mismo —sus pushes ya existen bajo el otro uuid— y la reagenda igual cuenta en las métricas.
export function createRescheduledCall(outcome, startUtc, { nowMs = Date.now() } = {}) {
  const plan = planRescheduledPushes(outcome, startUtc, {
    nowMs,
    leadMin: LEAD_MIN(),
    durationMin: CALL_DURATION_MIN(),
    graceMin: PUSH4_GRACE_MIN(),
    maxChain: MAX_CHAIN(),
  });
  if (!plan.ok) return plan;

  // Mismo closer + mismo minuto + MISMO lead = la cita real ya entró por Calendly o por el CRM.
  // Se adopta su uuid en vez de acuñar uno sintético que nadie iba a reconciliar después.
  // El lead es parte del match a propósito: un closer puede tener dos leads en el mismo slot,
  // y adoptar la call del otro dejaría el outcome colgado del prospecto equivocado.
  const slot = plan.pushes[0]?.call_start;
  const existing = slot
    ? findLiveCallAtSlot(outcome.closer_email, slot, {
        leadName: outcome.lead_name,
        leadPhone: outcome.lead_phone,
      })
    : null;
  if (existing && existing.event_uuid !== plan.uuid) {
    console.log(
      `[Calendly] reagenda: ${outcome.closer_email} ya tiene call viva a las ${slot} UTC ` +
        `(${existing.event_uuid}) — adopto ese evento y NO creo pushes sintéticos`
    );
    return { ok: true, uuid: existing.event_uuid, depth: plan.depth, scheduled: [], adopted: true };
  }

  const scheduled = [];
  for (const push of plan.pushes) {
    scheduleCalendlyPush(push);
    scheduled.push(`push${push.push_n}`);
  }
  return { ok: true, uuid: plan.uuid, depth: plan.depth, scheduled };
}
