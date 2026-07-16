// src/hubspot/nudge.js
// Cerebro del modelo nudge (PURO: sin red, sin DB → testeable). Traduce el resultado de
// matchCallToDeal (client.js) en una acción concreta, y arma los mensajes de WhatsApp.
//
// El nudge REEMPLAZA la pregunta del Push 4 SOLO para programas cubiertos (con pipeline
// en esta cuenta). Filosofía: no preguntar lo que HubSpot ya sabe; solo picar al closer
// cuando el dato falta. Red de seguridad: ante cualquier duda (programa no cubierto,
// error, etapa no clasificable), cae a preguntar (Push 4 clásico) para no perder el dato.

const PORTAL_ID = () => process.env.HUBSPOT_PORTAL_ID || '50929115';

// Deep-link directo al deal en HubSpot.
export function dealUrl(dealId) {
  return dealId ? `https://app.hubspot.com/contacts/${PORTAL_ID()}/deal/${dealId}` : null;
}

// Decide qué hacer con una call, dado el resultado de matchCallToDeal.
// Devuelve { action, dealUrl?, reason? } donde action ∈:
//   'ask'          → preguntar por WhatsApp (Push 4 clásico): programa no cubierto,
//                    error, o etapa no clasificable (red de seguridad — no perder el dato)
//   'silent'       → el closer ya avanzó el deal (resolved) → no molestar, cosechar métrica
//   'nudge_update' → deal estancado en Agendado tras la call → picar con link al deal
//   'nudge_create' → el lead/deal no está en HubSpot → picar al closer para que lo cree/arregle
export function decideNudgeAction(match) {
  if (!match || match.covered === false) return { action: 'ask', reason: 'uncovered' };
  if (match.error) return { action: 'ask', reason: 'error' };

  if (match.reason === 'no_contact' || match.reason === 'no_deal') {
    return { action: 'nudge_create', reason: match.reason };
  }
  if (match.status === 'resolved') return { action: 'silent' };
  if (match.status === 'stale') {
    return { action: 'nudge_update', dealUrl: dealUrl(match.deal?.id) };
  }
  // 'unknown' u otro → preferimos preguntar antes que quedarnos sin dato.
  return { action: 'ask', reason: 'unknown' };
}

// ─── Mensajes ─────────────────────────────────────────────────────────────────

// Nudge: el deal sigue en "Agendado" tras la call → recuérdale actualizar en HubSpot.
// Invita a avisar si se reagendó, para que la captura de reagenda (auto-scheduling)
// se dispare por la respuesta, sin una pregunta aparte.
export function buildDealNudgeMessage({ name, url }) {
  const lead = name || 'tu lead';
  return (
    `👋 Tu call con *${lead}* ya pasó y el deal sigue en *Agendado* en HubSpot.\n` +
    `Actualízalo cuando puedas 👉 ${url || 'HubSpot'}\n\n` +
    `_Si se reagendó, dime la fecha y yo agendo el precall de la nueva._`
  );
}

// Nudge de creación: el lead no aparece en HubSpot (o sin deal en el pipeline) → pídele
// al closer que lo cree/asocie. No preguntamos el resultado (eso sería el doble trabajo).
export function buildCreateDealNudgeMessage({ name, reason }) {
  const lead = name || 'ese lead';
  const detalle =
    reason === 'no_deal'
      ? `está en HubSpot pero sin deal en el pipeline del programa`
      : `no lo encuentro en HubSpot`;
  return (
    `👋 Tuviste una call con *${lead}* pero ${detalle}.\n` +
    `¿Le creas/actualizas el deal en HubSpot? Así queda registrada y no se pierde.`
  );
}
