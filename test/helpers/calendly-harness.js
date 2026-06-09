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

const API_BASE = 'https://api.calendly.com';

// ─── Fixtures: construir un evento de Calendly relativo a `nowMs` ──────────────
// startInMin: minutos desde "ahora" hasta el inicio de la llamada (negativo = pasada).
export function makeEvent({
  uuid,
  startInMin,
  startIso,
  closerEmail,
  prospectName = 'Juan Pérez',
  prospectPhone = '+57 300 111 2222',
  status = 'active',
  eventType = 'https://api.calendly.com/event_types/56efc028-ee2f-46e8-852c-e50d45b15b83',
  nowMs = Date.now(),
}) {
  const id = uuid || `evt-${Math.random().toString(36).slice(2, 10)}`;
  const start = startIso || new Date(nowMs + startInMin * 60000).toISOString();
  return {
    uuid: id,
    uri: `${API_BASE}/scheduled_events/${id}`,
    start_time: start,
    status,
    event_type: eventType,
    event_memberships: [{ user_email: closerEmail }],
    __invitee: prospectName === null ? null : { name: prospectName, text_reminder_number: prospectPhone },
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
    async listProgramEvents({ minStartIso, maxStartIso }) {
      if (opts.throwError) throw new Error(opts.throwError); // ej. 'Calendly 401: token inválido'
      const min = new Date(minStartIso).getTime();
      const max = new Date(maxStartIso).getTime();
      return [...byUuid.values()]
        .filter((e) => e.status === 'active')
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
  let nextId = 1;
  let globalPaused = false;
  const optinMap = new Map(); // phone normalizado → { phone, contact_jid, source, paused }
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
    markCalendlyPushSkipped(id, reason = '') {
      const r = rows.find((x) => x.id === id);
      if (r) {
        r.status = 'skipped';
        r.message = `${r.message || ''} | skip: ${reason}`;
      }
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
    setCloserPaused(phone, paused) {
      const p = normalizePhone(phone);
      const o = p ? optinMap.get(p) : null;
      if (o) o.paused = paused ? 1 : 0;
      return o ? 1 : 0;
    },
  };
}

// ─── Spy de WhatsApp ──────────────────────────────────────────────────────────
export function makeWaSpy() {
  const sent = [];
  return {
    sent,
    async sendMessage(to, text) {
      sent.push({ to, text });
    },
  };
}

// ─── Instalar el harness completo en el scheduler ─────────────────────────────
// Devuelve { deps, store, api, wa, clock } y deja el scheduler inyectado.
// Recuerda llamar a scheduler.__resetDeps() al terminar (los tests lo hacen).
export function installHarness(scheduler, { events = [], optins = [], nowMs = Date.now(), api: apiOpts = {} } = {}) {
  const clock = { ms: nowMs };
  const api = makeApi(events, apiOpts);
  const store = makeStore({ optins, nowRef: clock });
  const wa = makeWaSpy();

  const deps = {
    listProgramEvents: api.listProgramEvents,
    getEvent: api.getEvent,
    getFirstInvitee: api.getFirstInvitee,
    scheduleCalendlyPush: store.scheduleCalendlyPush,
    getDueCalendlyPushes: store.getDueCalendlyPushes,
    claimCalendlyPush: store.claimCalendlyPush,
    revertCalendlyPush: store.revertCalendlyPush,
    markCalendlyPushSent: store.markCalendlyPushSent,
    markCalendlyPushSkipped: store.markCalendlyPushSkipped,
    isOptedIn: store.isOptedIn,
    getOptin: store.getOptin,
    isCalendlyPaused: store.isCalendlyPaused,
    sendMessage: wa.sendMessage,
    now: () => clock.ms,
  };

  scheduler.__setDeps(deps);
  return { deps, store, api, wa, clock };
}
