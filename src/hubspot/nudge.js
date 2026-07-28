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

  // Varios homónimos con deal: el deal existe pero no sabemos CUÁL. Nunca elegimos por el
  // closer — le mostramos los candidatos. Ver dealsViaTwins en client.js.
  if (match.reason === 'ambiguous_twin') {
    return { action: 'nudge_review', dealUrls: (match.twinDealIds || []).map(dealUrl) };
  }
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
export function buildDealNudgeMessage({ name, url, viaTwin = null }) {
  const lead = name || 'tu lead';
  // Cuando el deal se encontró por el GEMELO, decirlo: el closer buscó por el correo de la
  // reunión, no lo encontró ahí, y sin esta línea creería que Juanito se equivocó de deal.
  const nota = viaTwin?.email
    ? `\n_Ojo: el deal está bajo *${viaTwin.email}*, no bajo el correo con el que agendó la reunión._`
    : '';
  return (
    `👋 Tu call con *${lead}* ya pasó y el deal sigue en *Agendado* en HubSpot.\n` +
    `Actualízalo cuando puedas 👉 ${url || 'HubSpot'}${nota}\n\n` +
    `_Si se reagendó, dime la fecha y yo agendo el precall de la nueva._`
  );
}

// Varios homónimos con deal en el pipeline: existe, pero elegir por el closer sería
// señalarle el deal de otra persona. Le mostramos los candidatos y decide él.
export function buildTwinReviewMessage({ name, urls = [] }) {
  const lead = name || 'ese lead';
  const lista = urls.filter(Boolean).map((u) => `• ${u}`).join('\n');
  return (
    `👋 Tuviste una call con *${lead}* y no le veo deal bajo el correo con el que agendó, ` +
    `pero encontré *${urls.length}* deals a nombre de esa persona:\n${lista}\n\n` +
    `Revisa cuál es y actualízalo. *No crees uno nuevo sin mirar estos primero.*`
  );
}

// Nudge de creación: el lead no aparece en HubSpot (o sin deal en el pipeline) → pídele
// al closer que lo cree/asocie. No preguntamos el resultado (eso sería el doble trabajo).
// Nudge de creación: ni por correo ni por nombre apareció un deal. Ya NO dice "créalo" a
// secas: en la mayoría de estos casos el deal EXISTE y está colgado de otro contacto, porque
// el lead agendó con un correo distinto al del formulario (regla de ops, 2026-07-28). Juanito
// ya buscó al gemelo por nombre y no lo halló, pero su búsqueda es por nombre exacto — un
// apellido escrito distinto se le escapa. Así que primero pedimos verificar, y solo después
// crear. El costo de los dos errores no es simétrico: un deal duplicado ensucia el pipeline
// y las métricas; treinta segundos de búsqueda no le cuestan nada a nadie.
export function buildCreateDealNudgeMessage({ name, reason }) {
  const lead = name || 'ese lead';
  const detalle =
    reason === 'no_deal'
      ? `está en HubSpot pero no le veo deal en el pipeline del programa`
      : `no lo encuentro en HubSpot con el correo de la reunión`;
  return (
    `👋 Tuviste una call con *${lead}* pero ${detalle}.\n\n` +
    `⚠️ Antes de crearlo, búscalo por *nombre* o *teléfono* — no por el correo de la reunión. ` +
    `Es común que el lead agende con un correo distinto al del formulario y el deal quede ` +
    `colgado de otro contacto (y ya sea tuyo).\n\n` +
    `Si de verdad no existe, créalo y déjalo en *Agendado*.`
  );
}
