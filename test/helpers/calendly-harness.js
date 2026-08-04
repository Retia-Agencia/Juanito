// test/helpers/calendly-harness.js
// Harness de escenarios para los jobs precall de Calendly (Tier 1: sin DB nativa,
// sin red, sin WhatsApp real). Reemplaza las 3 fronteras externas por dobles
// controlados e inyecta todo vía scheduler.__setDeps():
//
//   • API de Calendly → mock backed por fixtures (listProgramEvents/getEvent/getFirstInvitee)
//   • DB              → store en memoria que comparte la MISMA lógica pura
//                       (decidePushAction / computePush3Schedule) que src/db/index.js,
//                       de modo que probar el store == probar el comportamiento real
//   • WhatsApp        → spy que registra envíos (jamás manda nada)
//   • reloj (now)     → inyectable, para reproducir "reserva en 20 min", etc.
//
// Así se replican escenarios de forma determinista (lo que el dry-run en vivo NO
// permite: ese solo muestra lo que haya hoy en el Calendly real).

import { decidePushAction, sqliteUtcToMs } from '../../src/calendly/push-logic.js';
import { normalizePhone } from '../../src/common/utils.js';
import { accountOf, DEFAULT_ACCOUNT } from '../../src/calendly/accounts.js';

const API_BASE = 'https://api.calendly.com';

// ─── Fixture: una cuenta de Calendly ──────────────────────────────────────────
// Para escenarios multi-cuenta (dos agencias). Los defaults imitan a una agencia recién
// agregada: token propio, en dry-run, sin Push 4 y sin HubSpot.
export function makeAccount({
  key = 'acct2',
  label = key,
  token = `tok-${key}`,
  orgUri = `${API_BASE}/organizations/org-${key}`,
  eventTypes = {},
  dryRun = true,
  push4 = false,
  hubspot = false,
} = {}) {
  return {
    key,
    label,
    token: () => token,
    orgUri: () => orgUri,
    eventTypes,
    dryRun: () => dryRun,
    push4: () => push4,
    hubspot,
  };
}

// La cuenta real ('30x'), para componer escenarios de dos cuentas.
export const realAccount = () => accountOf(DEFAULT_ACCOUNT);

// ─── Fixtures: construir un evento de Calendly relativo a `nowMs` ──────────────
// startInMin: minutos desde "ahora" hasta el inicio de la llamada (negativo = pasada).
// `createdInMin`: minutos desde "ahora" hasta cuando se RESERVÓ la cita (negativo =
// pasado). Para el Push 0 (§18.C) importa: una reserva "reciente" dispara el aviso.
// Default OLD (−2 días) para que los escenarios que no prueban Push 0 no lo gatillen.
export function makeEvent({
  uuid,
  startInMin,
  startIso,
  closerEmail,
  prospectName = 'Juan Pérez',
  prospectPhone = '+57 300 111 2222',
  prospectEmail = 'juan.perez@ejemplo.com',
  status = 'active',
  eventType = 'https://api.calendly.com/event_types/56efc028-ee2f-46e8-852c-e50d45b15b83',
  joinUrl,
  createdInMin = -2 * 24 * 60,
  createdAtIso,
  nowMs = Date.now(),
  account,
}) {
  const id = uuid || `evt-${Math.random().toString(36).slice(2, 10)}`;
  const start = startIso || new Date(nowMs + startInMin * 60000).toISOString();
  const created = createdAtIso || new Date(nowMs + createdInMin * 60000).toISOString();
  return {
    uuid: id,
    uri: `${API_BASE}/scheduled_events/${id}`,
    start_time: start,
    created_at: created,
    status,
    event_type: eventType,
    // Solo para escenarios multi-cuenta: a qué cuenta responde este evento. Sin él, el
    // mock lo devuelve para cualquier cuenta (como siempre).
    _account: account,
    location: joinUrl ? { type: 'zoom', join_url: joinUrl } : undefined,
    event_memberships: [{ user_email: closerEmail }],
    __invitee:
      prospectName === null
        ? null
        : { name: prospectName, text_reminder_number: prospectPhone, email: prospectEmail },
  };
}

// ─── Mock de la API de Calendly ───────────────────────────────────────────────
// `events` es un array mutable de fixtures (makeEvent). Permite reagendar/cancelar
// entre llamadas para simular cambios después del fetch inicial.
export function makeApi(events, opts = {}) {
  const byUuid = new Map(events.map((e) => [e.uuid, e]));
  let inviteeFailFirst = opts.inviteeFailFirst || 0; // # de fallos transitorios a simular

  return {
    _events: byUuid,
    // `account` viene del fan-out multi-cuenta. Un evento sin `_account` pertenece a la
    // cuenta que se esté consultando (retro-compat: los escenarios de una sola cuenta no
    // lo declaran). `throwErrorFor` simula que SOLO una cuenta se cae (token muerto).
    async listProgramEvents({ minStartIso, maxStartIso, account }) {
      if (opts.throwError) throw new Error(opts.throwError); // ej. 'Calendly 401: token inválido'
      const perAccount = opts.throwErrorFor?.[account?.key];
      if (perAccount) throw new Error(perAccount);
      const min = new Date(minStartIso).getTime();
      const max = new Date(maxStartIso).getTime();
      return [...byUuid.values()]
        .filter((e) => e.status === 'active')
        .filter((e) => !e._account || !account || e._account === account.key)
        .filter((e) => {
          const t = new Date(e.start_time).getTime();
          return t >= min && t < max;
        })
        .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
        .map((e) => ({ ...e }));
    },
    async getEvent(uri) {
      const uuid = uri.split('/').pop();
      const e = byUuid.get(uuid);
      if (!e) throw new Error(`Calendly 404: ${uuid}`);
      return { ...e };
    },
    async getFirstInvitee(uri) {
      if (inviteeFailFirst > 0) {
        inviteeFailFirst -= 1;
        throw new Error('Calendly 500: fallo transitorio');
      }
      const uuid = uri.split('/').pop();
      const e = byUuid.get(uuid);
      return e?.__invitee ? { ...e.__invitee } : null;
    },
    // Helpers de escenario para mutar el calendario "en vivo":
    reschedule(uuid, newStartIso) {
      const e = byUuid.get(uuid);
      if (e) e.start_time = newStartIso;
    },
    cancel(uuid) {
      const e = byUuid.get(uuid);
      if (e) e.status = 'canceled';
    },
  };
}

// ─── Store en memoria de calendly_pushes (mismo contrato que src/db/index.js) ──
// `optins`: array de strings (teléfono → opt-in verificado CON hilo, se le asigna un
// contact_jid sintético, igual que un opt-in real vía handleCloserOptin) o de objetos
// { phone, contactJid?, source?, paused? }. Pasar `contactJid: null` explícito modela
// el caso sembrado/grandfathered SIN hilo (entrega estricta lo omite).
export function makeStore({ optins = [], nowRef } = {}) {
  const rows = [];
  const outcomes = []; // §18.AB: call_outcomes en memoria (misma semántica que el SQL)
  let nextId = 1;
  let nextOutcomeId = 1;
  let globalPaused = false;
  const optinMap = new Map(); // phone normalizado → { phone, contact_jid, source, paused }
  const closerPauses = new Set(); // pausa por-closer, por IDENTIDAD (email) — igual que en prod
                                  // (settings `calendly_pause:<email>`). NO por teléfono: una
                                  // persona con dos identidades se apaga por programa.
  for (const o of optins) {
    const obj = typeof o === 'string' ? { phone: o } : o;
    const p = normalizePhone(obj.phone);
    if (!p) continue;
    // Un opt-in verificado real SIEMPRE tiene contact_jid (lo captura handleCloserOptin).
    // Solo cuando se pasa `contactJid` explícito (incl. null) respetamos ese valor.
    const hasJid = Object.prototype.hasOwnProperty.call(obj, 'contactJid');
    const contact_jid = hasJid ? obj.contactJid : `${p}@s.whatsapp.net`;
    optinMap.set(p, { phone: p, contact_jid, source: obj.source || 'self', paused: obj.paused ? 1 : 0 });
  }
  const now = () => (nowRef ? nowRef.ms : Date.now());

  return {
    _rows: rows,
    scheduleCalendlyPush(p) {
      const existing = rows.find((r) => r.event_uuid === p.event_uuid && r.push_n === p.push_n);
      const { action, resetFromSent } = decidePushAction({ existing, incoming: p, nowMs: now() });
      if (action === 'insert') {
        rows.push({ id: nextId++, status: 'scheduled', sent_at: null, ...p });
        return 'new';
      }
      if (action === 'reschedule') {
        Object.assign(existing, {
          closer_email: p.closer_email,
          closer_phone: p.closer_phone,
          prospect_name: p.prospect_name,
          prospect_phone: p.prospect_phone,
          call_start: p.call_start,
          due_at: p.due_at,
          message: p.message,
        });
        if (resetFromSent) {
          existing.status = 'scheduled';
          existing.sent_at = null;
        }
        return 'rescheduled';
      }
      return 'unchanged';
    },
    getDueCalendlyPushes() {
      return rows
        .filter((r) => r.status === 'scheduled' && sqliteUtcToMs(r.due_at) <= now())
        .sort((a, b) => sqliteUtcToMs(a.due_at) - sqliteUtcToMs(b.due_at))
        .map((r) => ({ ...r }));
    },
    claimCalendlyPush(id) {
      const r = rows.find((x) => x.id === id);
      if (r && r.status === 'scheduled') {
        r.status = 'sending';
        return true;
      }
      return false;
    },
    revertCalendlyPush(id) {
      const r = rows.find((x) => x.id === id);
      if (r && r.status === 'sending') r.status = 'scheduled';
    },
    markCalendlyPushSent(id) {
      const r = rows.find((x) => x.id === id);
      if (r) {
        r.status = 'sent';
        r.sent_at = new Date(now()).toISOString();
      }
    },
    markCalendlyPushSkipped(id, reason = '', slug = null) {
      const r = rows.find((x) => x.id === id);
      if (r) {
        r.status = 'skipped';
        // Mismo COALESCE que el SQL: un slug nulo no pisa el que ya estuviera.
        r.skip_reason = slug ?? r.skip_reason ?? null;
        r.message = `${r.message || ''} | skip: ${reason}`;
      }
    },
    // Espejo de db.getSkipsAlertablesPorCloser: agrupa por closer los skips cuya causa es
    // accionable, en una ventana relativa a `call_start`.
    getSkipsAlertablesPorCloser(slugs, hours = 24) {
      const permitidos = new Set(slugs);
      const desde = now() - hours * 3600000;
      const porCloser = new Map();
      for (const r of rows) {
        if (r.status !== 'skipped' || !permitidos.has(r.skip_reason)) continue;
        if (sqliteUtcToMs(r.call_start) < desde) continue;
        const e = porCloser.get(r.closer_email) || { closer_email: r.closer_email, n: 0, motivos: new Set(), ejemplo: null };
        e.n += 1;
        e.motivos.add(r.skip_reason);
        e.ejemplo = r.prospect_name;
        porCloser.set(r.closer_email, e);
      }
      return [...porCloser.values()]
        .map((e) => ({ ...e, motivos: [...e.motivos].join(',') }))
        .sort((a, b) => b.n - a.n);
    },
    isOptedIn(phone) {
      const p = normalizePhone(phone);
      return p ? optinMap.has(p) : false;
    },
    getOptin(phone) {
      const p = normalizePhone(phone);
      return p ? optinMap.get(p) || null : null;
    },
    optIn(phone, contactJid = null) {
      const p = normalizePhone(phone);
      if (p) optinMap.set(p, { phone: p, contact_jid: contactJid, source: 'self', paused: 0 });
    },
    // Botón de pánico (mismo contrato que db.isCalendlyPaused/setCalendlyPaused).
    isCalendlyPaused() {
      return globalPaused;
    },
    setCalendlyPaused(paused) {
      globalPaused = !!paused;
    },
    // Pausa por-closer, por IDENTIDAD (email), igual que db.setCloserPaused/isCloserPaused.
    setCloserPaused(email, paused) {
      const e = String(email || '').toLowerCase().trim();
      if (!e) return 0;
      if (paused) closerPauses.add(e);
      else closerPauses.delete(e);
      return 1;
    },
    isCloserPaused(email) {
      return closerPauses.has(String(email || '').toLowerCase().trim());
    },

    // ─── Outcomes post-call (§18.AB) ──────────────────────────────────────────
    _outcomes: outcomes,
    createPendingOutcome(o) {
      if (outcomes.some((x) => x.event_uuid === o.event_uuid)) return 'exists';
      outcomes.push({
        id: nextOutcomeId++,
        event_uuid: o.event_uuid,
        program: o.program ?? null,
        closer_email: o.closer_email ?? null,
        closer_phone: normalizePhone(o.closer_phone) || null,
        closer_name: o.closer_name ?? null,
        lead_name: o.lead_name ?? null,
        lead_phone: o.lead_phone ?? null,
        call_start: o.call_start,
        asistencia: null,
        resultado: null,
        status: 'pending',
        asked_at: now(),
        prompted_at: now(),
        answered_at: null,
        reminded: o.reminded ?? 0,
        raw_reply: null,
        rescheduled_to: null,
        reschedule_uuid: null,
        reschedule_asked: 0,
      });
      return 'new';
    },
    recordAutoOutcome(o) {
      const ex = outcomes.find((x) => x.event_uuid === o.event_uuid);
      if (ex) {
        if (ex.status === 'pending') {
          ex.asistencia = o.asistencia;
          ex.resultado = o.resultado ?? null;
          ex.status = 'auto';
          ex.answered_at = now();
        }
        return;
      }
      outcomes.push({
        id: nextOutcomeId++,
        event_uuid: o.event_uuid,
        program: o.program ?? null,
        closer_email: o.closer_email ?? null,
        closer_phone: normalizePhone(o.closer_phone) || null,
        closer_name: o.closer_name ?? null,
        lead_name: o.lead_name ?? null,
        lead_phone: o.lead_phone ?? null,
        call_start: o.call_start,
        asistencia: o.asistencia,
        resultado: o.resultado ?? null,
        status: 'auto',
        asked_at: null,
        answered_at: now(),
        reminded: 0,
        raw_reply: null,
      });
    },
    // Misma regla de 3 capas que el SQL real (§18.AC): mid-flow caliente → FIFO de las que
    // esperan asistencia → mid-flow frío. La ventana evita que una fila vieja a medio flujo
    // se lleve para siempre toda respuesta del closer.
    getActiveOutcomeForCloser(phone, windowMin = Number(process.env.OUTCOME_REPLY_WINDOW_MIN || 120)) {
      const p = normalizePhone(phone);
      if (!p) return null;
      const abiertos = outcomes.filter(
        (x) => x.closer_phone === p && (x.status === 'pending' || x.status === 'awaiting_date')
      );
      const cutoff = now() - windowMin * 60000;
      const hot = abiertos
        .filter((x) => x.asistencia != null && x.prompted_at != null && x.prompted_at >= cutoff)
        .sort((a, b) => b.prompted_at - a.prompted_at)[0];
      if (hot) return hot;
      const fifo = abiertos
        .filter((x) => x.status === 'pending' && x.asistencia == null)
        .sort((a, b) => a.asked_at - b.asked_at)[0];
      if (fifo) return fifo;
      return abiertos.filter((x) => x.asistencia != null).sort((a, b) => a.asked_at - b.asked_at)[0] || null;
    },
    setOutcomeAsistencia(id, asistencia, raw = null) {
      const o = outcomes.find((x) => x.id === id);
      if (!o) return;
      o.asistencia = asistencia;
      o.raw_reply = raw;
      o.prompted_at = now();
      // show → falta el resultado · reagendado → falta la fecha · resto → cierra.
      o.status = asistencia === 'show' ? 'pending' : asistencia === 'reagendado' ? 'awaiting_date' : 'answered';
      if (o.status === 'answered') o.answered_at = now();
    },
    setOutcomeReschedule(id, { startUtc = null, uuid = null, rawReply = null } = {}) {
      const o = outcomes.find((x) => x.id === id);
      if (!o) return;
      o.rescheduled_to = startUtc;
      o.reschedule_uuid = uuid;
      o.raw_reply = `${o.raw_reply || ''} | ${rawReply || ''}`.trim();
      o.status = 'answered';
      o.answered_at = now();
    },
    getAwaitingDateOutcomes({ maxAsked = 3, minHours = 8 } = {}) {
      const cutoff = now() - minHours * 3600000;
      return outcomes
        .filter(
          (x) =>
            x.status === 'awaiting_date' &&
            x.reschedule_asked < maxAsked &&
            (x.prompted_at == null || x.prompted_at <= cutoff)
        )
        .sort((a, b) => a.asked_at - b.asked_at)
        .map((x) => ({ ...x }));
    },
    markReschedulePrompted(id) {
      const o = outcomes.find((x) => x.id === id);
      if (o) {
        o.reschedule_asked++;
        o.prompted_at = now();
      }
    },
    expireAwaitingDateOutcomes({ maxAsked = 3 } = {}) {
      let changes = 0;
      for (const o of outcomes) {
        if (o.status === 'awaiting_date' && o.reschedule_asked >= maxAsked) {
          o.status = 'answered';
          o.answered_at = now();
          changes++;
        }
      }
      return { changes };
    },
    getPendingManualPushes() {
      return rows
        .filter(
          (r) =>
            String(r.event_uuid).startsWith('manual:') &&
            r.status === 'scheduled' &&
            sqliteUtcToMs(r.call_start) > now() - 3600000
        )
        .map((r) => ({ ...r }));
    },
    supersedeManualPushes(manualUuid, realUuid) {
      let changes = 0;
      for (const r of rows) {
        if (r.event_uuid === manualUuid && r.status === 'scheduled') {
          r.status = 'skipped';
          r.message = `${r.message || ''} | skip: superseded por evento real ${realUuid}`;
          changes++;
        }
      }
      for (const o of outcomes) if (o.reschedule_uuid === manualUuid) o.reschedule_uuid = realUuid;
      return changes;
    },
    setOutcomeResultado(id, resultado, raw = null) {
      const o = outcomes.find((x) => x.id === id);
      if (!o) return;
      o.resultado = resultado;
      o.raw_reply = `${o.raw_reply || ''} | ${raw}`;
      o.status = 'answered';
      o.answered_at = now();
    },
    getDueOutcomeReminders(minMinutes = 30) {
      const cutoff = now() - minMinutes * 60000;
      return outcomes
        .filter((x) => x.status === 'pending' && x.asistencia == null && x.reminded === 0 && x.asked_at <= cutoff)
        .sort((a, b) => a.asked_at - b.asked_at)
        .map((x) => ({ ...x }));
    },
    markOutcomeReminded(id) {
      const o = outcomes.find((x) => x.id === id);
      if (o) o.reminded = 1;
    },
    expireUnansweredOutcomes(minMinutes = 30) {
      const cutoff = now() - minMinutes * 60000;
      let changes = 0;
      for (const o of outcomes) {
        if (o.status === 'pending' && o.asistencia == null && o.reminded === 1 && o.asked_at <= cutoff) {
          o.status = 'no_answer';
          changes++;
        }
      }
      return { changes };
    },

    // ─── Barrido periódico de cosecha (§18.AH) ────────────────────────────────
    getStaleHarvestCandidates({ maxAgeHours = 72 } = {}) {
      const cutoff = now() - maxAgeHours * 3600000;
      return outcomes
        .filter(
          (x) =>
            (x.status === 'pending' || x.status === 'no_answer') &&
            x.asistencia == null &&
            x.program != null &&
            !String(x.event_uuid).startsWith('manual:') &&
            sqliteUtcToMs(x.call_start) >= cutoff
        )
        .map((x) => ({ ...x }));
    },
    applyHarvestedOutcome(id, { asistencia, resultado = null } = {}) {
      const o = outcomes.find((x) => x.id === id);
      if (o && o.asistencia == null) {
        o.asistencia = asistencia;
        o.resultado = resultado;
        o.status = 'auto';
        o.answered_at = now();
      }
    },
  };
}

// ─── Spy de WhatsApp ──────────────────────────────────────────────────────────
export function makeWaSpy() {
  const sent = [];
  const docs = [];
  return {
    sent,
    // Brochures adjuntos del Push 1. Se registran aparte de `sent` para no descuadrar
    // las aserciones de conteo de mensajes que ya existen en los escenarios.
    docs,
    async sendMessage(to, text) {
      sent.push({ to, text });
    },
    async sendDocument(to, { buffer, fileName, mimetype, caption } = {}) {
      docs.push({ to, fileName, mimetype, caption, bytes: buffer?.length ?? 0 });
    },
  };
}

// ─── Instalar el harness completo en el scheduler ─────────────────────────────
// Devuelve { deps, store, api, wa, clock } y deja el scheduler inyectado.
// Recuerda llamar a scheduler.__resetDeps() al terminar (los tests lo hacen).
export function installHarness(
  scheduler,
  { events = [], optins = [], nowMs = Date.now(), api: apiOpts = {}, match, accounts } = {}
) {
  const clock = { ms: nowMs };
  const api = makeApi(events, apiOpts);
  const store = makeStore({ optins, nowRef: clock });
  const wa = makeWaSpy();

  // Modelo nudge (§18.AF): mock de matchCallToDeal. `match` puede ser una función
  // (email, programKey) → resultado, o un objeto fijo. Sin `match` → devuelve covered:false
  // (equivale a HubSpot apagado → todo cae a Push 4 clásico).
  const matchCalls = [];
  const matchCallToDeal = async ({ email, programKey }) => {
    matchCalls.push({ email, programKey });
    if (typeof match === 'function') return match({ email, programKey });
    return match || { covered: false };
  };

  const deps = {
    // Cuentas de Calendly a pollear. Por default, solo la real ('30x'), para que los tests
    // que no saben de multi-cuenta se comporten como siempre. Un test puede pasar
    // `accounts: [...]` para simular dos agencias (ver makeAccount).
    accounts: () => accounts || [accountOf(DEFAULT_ACCOUNT)],
    listProgramEvents: api.listProgramEvents,
    getEvent: api.getEvent,
    getFirstInvitee: api.getFirstInvitee,
    scheduleCalendlyPush: store.scheduleCalendlyPush,
    getDueCalendlyPushes: store.getDueCalendlyPushes,
    claimCalendlyPush: store.claimCalendlyPush,
    revertCalendlyPush: store.revertCalendlyPush,
    markCalendlyPushSent: store.markCalendlyPushSent,
    markCalendlyPushSkipped: store.markCalendlyPushSkipped,
    getSkipsAlertablesPorCloser: store.getSkipsAlertablesPorCloser,
    isOptedIn: store.isOptedIn,
    getOptin: store.getOptin,
    isCalendlyPaused: store.isCalendlyPaused,
    isCloserPaused: store.isCloserPaused,
    sendMessage: wa.sendMessage,
    sendDocument: wa.sendDocument,
    now: () => clock.ms,
    // §18.AB: outcomes post-call.
    createPendingOutcome: store.createPendingOutcome,
    recordAutoOutcome: store.recordAutoOutcome,
    getDueOutcomeReminders: store.getDueOutcomeReminders,
    markOutcomeReminded: store.markOutcomeReminded,
    expireUnansweredOutcomes: store.expireUnansweredOutcomes,
    // §18.AH: barrido periódico de cosecha.
    getStaleHarvestCandidates: store.getStaleHarvestCandidates,
    applyHarvestedOutcome: store.applyHarvestedOutcome,
    // §18.AC: reagendas.
    getPendingManualPushes: store.getPendingManualPushes,
    supersedeManualPushes: store.supersedeManualPushes,
    getAwaitingDateOutcomes: store.getAwaitingDateOutcomes,
    markReschedulePrompted: store.markReschedulePrompted,
    expireAwaitingDateOutcomes: store.expireAwaitingDateOutcomes,
    // §18.AF: modelo nudge (HubSpot). hubspotEnabled=true solo si el test dio un `match`
    // (modela "HubSpot configurado"); sin él, el nudge se salta → Push 4 clásico.
    matchCallToDeal,
    hubspotEnabled: () => Boolean(match),
  };

  scheduler.__setDeps(deps);
  return { deps, store, api, wa, clock, matchCalls };
}
