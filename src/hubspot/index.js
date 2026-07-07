// src/hubspot/index.js
// Adaptador: deals de HubSpot → la MISMA forma de "evento" que consume el motor precall
// (src/scheduler/calendly.js). Así el digest de Push 1/2 funciona sin tocar su lógica:
// solo cambia de dónde salen las citas (HubSpot en vez de Calendly).
//
// Mapeo de campos (HubSpot deal → evento estilo Calendly):
//   deal.id                           → uri  ('hubspot:deal:<id>')
//   props.calendly_meeting_start_time → start_time (ISO)
//   props.pipeline                    → event_type (clave de programa; programKeyOf la acepta)
//   props.calendly_host_email         → event_memberships[0].user_email  (el CLOSER, no el owner)
//   props.dealname                    → invitee.name          (nombre del lead — ver open item)
//   props.telefono_de_contcato        → invitee.text_reminder_number (teléfono del lead)

import { searchDeals, hasHubspotCreds } from './client.js';
import { normalizePhone } from '../common/utils.js';

export { hasHubspotCreds };

// Pipelines gestionados: pipeline HubSpot → { stage 'Agendado', programKey }. Los IDs son
// overridables por env (mismo patrón lazy del repo) con los defaults ya validados.
export function pipelineConfig(env = process.env) {
  return [
    {
      pipeline: env.HUBSPOT_PIPELINE_SECONDBRAIN || '904247681',
      stage: env.HUBSPOT_STAGE_SECONDBRAIN || '1368121620',
      program: 'second_brain',
    },
    {
      pipeline: env.HUBSPOT_PIPELINE_LINKEDIN || '906259304',
      stage: env.HUBSPOT_STAGE_LINKEDIN || '1372359685',
      program: 'linkedin',
    },
  ];
}

// pipeline id → programKey. null si el deal viene de un pipeline no gestionado (no debería
// pasar: el query ya filtra por estos pipelines).
function programForPipeline(pipelineId, cfg) {
  const hit = cfg.find((p) => p.pipeline === pipelineId);
  return hit ? hit.program : null;
}

// Un deal → evento estilo Calendly. El invitee se precalcula acá: HubSpot ya trae el
// teléfono en el propio deal, así que NO hace falta un segundo fetch como en Calendly.
export function dealToEvent(deal, cfg = pipelineConfig()) {
  const p = deal.properties || {};
  return {
    uri: `hubspot:deal:${deal.id}`,
    start_time: p.calendly_meeting_start_time || null,
    event_type: programForPipeline(p.pipeline, cfg), // clave de programa; programKeyOf la acepta
    event_memberships: [{ user_email: (p.calendly_host_email || '').toLowerCase() || null }],
    status: 'active',
    _invitee: {
      name: p.dealname || null,
      // buildLeadLink vuelve a normalizar a dígitos igual; lo hacemos ya para logs limpios.
      text_reminder_number: p.telefono_de_contcato ? normalizePhone(p.telefono_de_contcato) : null,
    },
  };
}

// Cache del último listProgramEvents: uri → _invitee. Permite que getFirstInvitee sea
// síncrono (sin segundo fetch): los datos del lead ya vinieron con el deal. Dentro de un
// mismo runDigest la secuencia es listProgramEvents → getFirstInvitee(por evento), y los
// dos crons (7pm/6:30am) nunca corren a la vez, así que el cache compartido es seguro.
let _inviteeByUri = new Map();

// Contrato del motor: listProgramEvents({minStartIso,maxStartIso}) → [evento]. Descarta
// deals sin closer o sin hora (no se pueden pushear).
export async function listProgramEvents({ minStartIso, maxStartIso }) {
  const cfg = pipelineConfig();
  const deals = await searchDeals({ minStartIso, maxStartIso, pipelines: cfg });
  const events = [];
  const cache = new Map();
  for (const deal of deals) {
    const ev = dealToEvent(deal, cfg);
    if (!ev.event_memberships[0].user_email || !ev.start_time) continue;
    cache.set(ev.uri, ev._invitee);
    events.push(ev);
  }
  _inviteeByUri = cache;
  return events;
}

// Contrato del motor: getFirstInvitee(ev.uri) → { name, text_reminder_number } | null.
// Async para igualar la firma de la versión de Calendly (que sí toca red), aunque acá los
// datos ya vinieron con el deal en listProgramEvents.
export async function getFirstInvitee(uri) {
  return _inviteeByUri.get(uri) || null;
}
