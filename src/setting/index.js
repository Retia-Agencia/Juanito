// src/setting/index.js
// Orquestación del setteo a leads que no agendaron (§18.AD). Juanito es el CEREBRO:
// detecta al lead sin agendar (Sheet de EstadoX), agenda una cadencia corta (máx 2
// toques) y dispara plantillas aprobadas por la Cloud API oficial (Twilio) a un número
// WABA DEDICADO. El BRAZO que envía es la Cloud API, no Baileys → cero riesgo de ban.
//
// Garantías (calcadas de Calendly/outreach):
//  - Botón de pánico global (isSettingPaused) — corta todo sin redeploy.
//  - Idempotencia: agendar es UNIQUE(program, lead_key, touch_n); reintentar no duplica.
//  - Claim atómico por fila (scheduled→sending) → dos ciclos solapados no doble-envían.
//  - Re-check antes de enviar: si el lead ya agendó (col I del Sheet) o se dio de baja,
//    se cancelan los toques vivos y no se le escribe.
//  - Quiet hours: pausa la entrega (no avanza estado) — reintenta al volver el horario.
//  - Modo DRY_RUN (default true): loguea y marca 'sent' sin llamar a la Cloud API.
//
// Deps inyectables (__setDeps) para testear el ciclo sin Sheet/Twilio/DB reales.

import { maskJid } from '../common/utils.js';
import { isWithinQuietHours } from '../common/utils.js';
import { bossDmTarget } from '../common/roles.js';
import { computeEnrollment, computeSettingTouches, toSqliteUtc } from './setting-logic.js';
import { resolveTemplate } from './templates.js';

const DRY_RUN = () => process.env.SETTING_DRY_RUN !== 'false'; // default true
const ENROLL_MAX_AGE_MS = () => Number(process.env.SETTING_ENROLL_MAX_AGE_H || 48) * 3600 * 1000;
const TOUCH1_DELAY_MIN = () => Number(process.env.SETTING_TOUCH1_DELAY_MIN || 120);   // 2h
const TOUCH2_DELAY_MIN = () => Number(process.env.SETTING_TOUCH2_DELAY_MIN || 2880);  // 48h

// ¿Están las credenciales de Twilio para el envío real? (el job se autodesactiva sin ellas)
export function hasCloudApiCreds(env = process.env) {
  return !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WA_FROM);
}

// ─── Seam de dependencias ─────────────────────────────────────────────────────

let _injectedDeps = null;
let _sender = null; // sender de la Cloud API, memoizado (su cola vive entre ciclos)
export function __setDeps(deps) {
  _injectedDeps = deps;
}
export function __resetDeps() {
  _injectedDeps = null;
  _sender = null;
}

async function buildSender() {
  if (_sender) return _sender;
  if (!hasCloudApiCreds()) return null;
  const { createCloudApiSender } = await import('../whatsapp/cloud-api.js');
  _sender = createCloudApiSender({
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    from: process.env.TWILIO_WA_FROM,
  });
  return _sender;
}

async function resolveDeps() {
  if (_injectedDeps) return _injectedDeps;
  const [db, leadSource, whatsapp] = await Promise.all([
    import('../db/index.js'),
    import('./lead-source-estadox.js'),
    import('../whatsapp/index.js'),
  ]);
  const sender = await buildSender();
  return {
    fetchLeads: leadSource.fetchEstadoxLeads,
    scheduleSettingTouch: db.scheduleSettingTouch,
    getDueSettingTouches: db.getDueSettingTouches,
    claimSettingTouch: db.claimSettingTouch,
    revertSettingTouch: db.revertSettingTouch,
    markSettingSent: db.markSettingSent,
    markSettingSkipped: db.markSettingSkipped,
    cancelSettingTouches: db.cancelSettingTouches,
    isSettingOptedOut: db.isSettingOptedOut,
    isSettingPaused: db.isSettingPaused,
    sendTemplate: sender ? sender.sendTemplate.bind(sender) : null,
    sendBossMessage: whatsapp.sendMessage,
    notifyTarget: async () => bossDmTarget(),
    isWithinQuietHours,
  };
}

// ─── Un ciclo (exportado para tests / disparo manual) ─────────────────────────

let _running = false;

export async function runSettingCycle(now = new Date()) {
  if (_running) {
    console.log('[Setteo] ciclo anterior aún en curso — salto este tick');
    return { enrolled: 0, sent: 0 };
  }
  _running = true;
  try {
    return await _runSettingCycle(now);
  } finally {
    _running = false;
  }
}

async function _runSettingCycle(now = new Date()) {
  const d = await resolveDeps();
  const nowMs = now.getTime();

  // 0) Botón de pánico global.
  if (d.isSettingPaused && d.isSettingPaused()) {
    console.log('[Setteo] PAUSADO (global) — no se enrola ni se entrega este tick');
    return { enrolled: 0, sent: 0 };
  }

  // 1) Traer leads del Sheet (una sola llamada de red). Si falla, abortamos el ciclo:
  //    la entrega necesita bookedByKey para el re-check "¿ya agendó?".
  let leads = [];
  let bookedByKey = new Map();
  try {
    ({ leads, bookedByKey } = await d.fetchLeads({ enrollMaxAgeMs: ENROLL_MAX_AGE_MS() }));
  } catch (e) {
    console.error('[Setteo] no pude leer el Sheet:', e.message);
    return { enrolled: 0, sent: 0 };
  }

  // 2) Enrolar (dedup por lead_key en este ciclo; el UNIQUE cubre entre ciclos).
  const seen = new Set();
  let enrolled = 0;
  for (const lead of leads) {
    if (seen.has(lead.lead_key)) continue;
    seen.add(lead.lead_key);
    if (d.isSettingOptedOut(lead.to_phone)) continue;
    const { enroll } = computeEnrollment({ submittedMs: lead.submittedMs, nowMs, enrollMaxAgeMs: ENROLL_MAX_AGE_MS() });
    if (!enroll) continue;
    const touches = computeSettingTouches({
      nowMs,
      touch1DelayMin: TOUCH1_DELAY_MIN(),
      touch2DelayMin: TOUCH2_DELAY_MIN(),
    });
    for (const t of touches) {
      const r = d.scheduleSettingTouch({
        program: lead.program,
        lead_key: lead.lead_key,
        to_phone: lead.to_phone,
        to_name: lead.to_name,
        touch_n: t.touch_n,
        due_at: toSqliteUtc(t.dueMs),
      });
      if (r === 'new') enrolled++;
    }
  }

  // 3) Entregar los toques vencidos.
  const quiet = (d.isWithinQuietHours || isWithinQuietHours)(now);
  let sent = 0;
  for (const row of d.getDueSettingTouches()) {
    try {
      // Baja → cancelar todo lo vivo del lead y saltar.
      if (d.isSettingOptedOut(row.to_phone)) {
        d.cancelSettingTouches(row.program, row.lead_key, 'optout');
        continue;
      }
      // Re-check: ¿ya agendó entre toques? → cancelar el resto.
      if (bookedByKey.get(row.lead_key) === true) {
        d.cancelSettingTouches(row.program, row.lead_key, 'ya-agendo');
        continue;
      }
      // Quiet hours: pausa (no avanza) → reintenta al salir del horario de descanso.
      if (quiet) continue;

      const tpl = resolveTemplate({ program: row.program, touch_n: row.touch_n, to_name: row.to_name });
      if (!tpl) {
        d.markSettingSkipped(row.id, 'sin-plantilla');
        continue;
      }
      // Claim atómico: si otro worker ya la tomó → saltar.
      if (!d.claimSettingTouch(row.id)) continue;

      if (DRY_RUN()) {
        console.log(`[Setteo][DRY-RUN] toque ${row.touch_n} → ${maskJid(row.to_phone)} ${tpl.preview}`);
        d.markSettingSent(row.id, `DRY-RUN ${tpl.preview}`);
        sent++;
        continue;
      }

      try {
        if (!d.sendTemplate) throw new Error('Cloud API no inicializada (faltan credenciales Twilio)');
        await d.sendTemplate({ to: row.to_phone, contentSid: tpl.contentSid, vars: tpl.vars });
        d.markSettingSent(row.id, tpl.preview);
        sent++;
        console.log(`[Setteo] toque ${row.touch_n} enviado → ${maskJid(row.to_phone)} (${row.program})`);
        // FYI al jefe/equipo (no aprobación): visibilidad de cada salida.
        if (d.notifyTarget && d.sendBossMessage) {
          const target = await d.notifyTarget();
          if (target) {
            await d
              .sendBossMessage(target, `✅ Setteo (${row.program}) toque ${row.touch_n} → ${row.to_name || row.to_phone}`)
              .catch(() => {});
          }
        }
      } catch (err) {
        // No se avanza estado: volver a 'scheduled' → el próximo ciclo reintenta.
        d.revertSettingTouch(row.id);
        console.error(`[Setteo] envío #${row.id} falló: ${err.message}`);
      }
    } catch (err) {
      console.error(`[Setteo] toque #${row.id} error: ${err.message}`);
    }
  }

  return { enrolled, sent };
}
