// src/whatsapp/disconnect-logic.js
// QUÉ HACER cuando WhatsApp cierra el socket. Módulo PURO: sin red, sin DB, sin deps nativas.
//
// Por qué existe separado de whatsapp/index.js: ese archivo no es testeable — importarlo abre
// Baileys — y esta es la decisión más cara del sistema. Un error acá no se ve como un bug: se ve
// como el número del bot inutilizable por días (softban del 2026-07-28). Mismo patrón que
// push-logic.js / outcome-logic.js / reschedule-logic.js: la DECISIÓN acá y testeada, el EFECTO
// (salir, reabrir, pedir QR) en el módulo que toca el mundo.
//
// ─── La distinción que motiva todo esto (§18.BN) ─────────────────────────────
// Hasta el 2026-08-26, cualquier cierre con la sesión ya conectada era `exit(1)`. Eso trata igual
// dos cosas opuestas:
//
//   · un RECHAZO de WhatsApp (405, 403): "no me gusta lo que estás haciendo". La respuesta
//     correcta es silencio y backoff largo. Reintentar rápido es lo que causa el softban.
//   · un CABLE CORTADO (428, 408): el socket se cayó, sin juicio de valor. La respuesta correcta
//     es volver a conectarlo.
//
// Medido: 4 cierres 428 en 13 horas, con el bot corriendo sano entre 45 min y 4 h. Cada uno
// costaba un proceso nuevo, una reconexión completa de Baileys, la cola de envío en memoria
// entera, y —hasta el arreglo de hoy— un push huérfano en 'sending' si caía en mal momento.

// Códigos de Baileys (DisconnectReason). Se escriben acá como números y NO se importan del
// paquete a propósito: este módulo no puede depender de nada que arrastre Baileys, porque
// entonces dejaría de ser testeable, que es toda su razón de existir. Verificados contra
// node_modules/@whiskeysockets/baileys/lib/Types/index.d.ts el 2026-08-26.
export const CIERRE = {
  loggedOut: 401,
  forbidden: 403,
  timedOut: 408, // === connectionLost
  multideviceMismatch: 411,
  connectionClosed: 428,
  connectionReplaced: 440,
  badSession: 500,
  unavailableService: 503,
  restartRequired: 515,
};

// ⚠️ ALLOWLIST, nunca denylist. Solo estos dos códigos se reabren en caliente; TODO lo demás
// —incluido cualquier código que no hayamos visto nunca— cae al `exit` de siempre, que es el
// comportamiento conservador. Si algún día WhatsApp inventa un código nuevo, el default tiene
// que ser el que no nos banea.
//
// Por qué estos dos y no más:
//   428 connectionClosed · 408 timedOut/connectionLost → el socket se cayó. Sin juicio.
//
// Los que PARECEN candidatos y no lo son:
//   440 connectionReplaced → otra sesión tomó el lugar. Reabrir es PELEARSE por la sesión en
//       loop, o sea el peor caso posible: dos clientes turnándose para echar al otro.
//   503 unavailableService → caída del lado de WhatsApp. Reabrir contra un servicio caído es
//       martillar. El backoff de entrypoint.sh (30→300s) es mejor herramienta que un reopen.
//   500 badSession / 411 multideviceMismatch → el problema es la sesión, y reabrirla la
//       reproduce idéntica. Un proceso nuevo al menos re-lee el auth state del disco.
const REABRIBLES = new Set([CIERRE.connectionClosed, CIERRE.timedOut]);

// Presupuesto de reaperturas. Un reopen SIN límite es el bug del softban con otro nombre, así
// que el freno es parte de la decisión, no una opción.
export const MAX_REOPENS = 3;
// Esperas antes de cada reopen. NUNCA inmediata: reabrir al instante contra un WhatsApp que
// está cortando es exactamente el patrón que dispara la detección. Crecen porque si el primero
// no alcanzó, el problema no era un parpadeo.
export const ESPERAS_MS = [5000, 15000, 45000];
// Cuánto tiene que haber durado la conexión para que la caída cuente como AISLADA y el
// presupuesto vuelva a cero. Es el MISMO concepto que el reset de `ATTEMPT` en entrypoint.sh
// (§18.BN), y a propósito el mismo número: un solo significado de "sano" en todo el sistema.
// Dos umbrales distintos para la misma idea es garantía de que algún día se contradigan.
export const SANO_MS = 10 * 60 * 1000;

/**
 * Decide qué hacer ante un `connection === 'close'`.
 *
 * @param {number|undefined} statusCode  código de Boom del cierre (undefined si no vino)
 * @param {boolean} hasConnected  ¿este PROCESO llegó a abrir la conexión alguna vez?
 * @param {boolean} hasCreds      ¿hay sesión vinculada en disco? (`creds.me?.id`, NO
 *                                `creds.registered` — ver la nota en whatsapp/index.js)
 * @param {number} reopens        reaperturas ya gastadas en la racha actual
 * @param {number} uptimeMs       cuánto duró ESTA conexión antes de caerse
 * @param {number} healthyMs      a partir de cuánto la caída cuenta como aislada
 * @param {boolean} hotReopen     ¿está prendido el flag? Apagado ⇒ se comporta como antes
 * @param {number} pairingRetries intentos de QR gastados
 * @param {number} maxPairing     tope de intentos de QR
 * @returns {{action:'exit'|'reopen'|'pair', code?:number, waitMs?:number, reason:string}}
 */
export function decideOnClose({
  statusCode,
  hasConnected,
  hasCreds,
  reopens = 0,
  uptimeMs = 0,
  healthyMs = SANO_MS,
  hotReopen = false,
  pairingRetries = 0,
  maxPairing = 5,
}) {
  // 1) Sesión cerrada desde el teléfono. Salida LIMPIA (code 2) para que entrypoint.sh NO
  //    reintente: no hay nada que reintentar hasta que un humano re-vincule.
  if (statusCode === CIERRE.loggedOut)
    return { action: 'exit', code: 2, reason: 'loggedOut: hay que re-vincular a mano' };

  // 2) Flujo normal de Baileys justo después de vincular. Reapertura en caliente, y NO gasta
  //    presupuesto: no es una caída, es parte del handshake.
  if (statusCode === CIERRE.restartRequired)
    return { action: 'reopen', waitMs: 1000, reason: 'restartRequired (515): flujo normal de pairing' };

  // 3) Ya habíamos conectado en este proceso: acá vive la distinción rechazo vs. cable.
  if (hasConnected) {
    if (!hotReopen)
      return { action: 'exit', code: 1, reason: `cierre ${statusCode} (reopen en caliente apagado)` };
    if (!REABRIBLES.has(statusCode))
      return { action: 'exit', code: 1, reason: `cierre ${statusCode}: no está en la allowlist de reabribles` };
    // La conexión duró lo suficiente ⇒ esta caída no es continuación de la anterior y el
    // presupuesto vuelve a cero. Sin esto, cuatro caídas repartidas en un día agotarían las
    // reaperturas igual que el `ATTEMPT` de entrypoint.sh acumulaba hacia el borde — el mismo
    // bug, un nivel más arriba, y no tiene ningún sentido replicarlo acá sabiéndolo.
    const gastadas = uptimeMs >= healthyMs ? 0 : reopens;
    // El presupuesto agotado NO es un fracaso: es la escalera funcionando. Se sale y
    // entrypoint.sh aplica su backoff largo, que es la herramienta correcta cuando reabrir
    // rápido ya se probó tres veces y no alcanzó.
    if (gastadas >= MAX_REOPENS)
      return { action: 'exit', code: 1, reason: `${MAX_REOPENS} reaperturas gastadas: le paso el problema al backoff` };
    return {
      action: 'reopen',
      resetReopens: gastadas === 0 && reopens > 0,
      waitMs: ESPERAS_MS[Math.min(gastadas, ESPERAS_MS.length - 1)],
      reason:
        `cierre ${statusCode} (cable): reapertura ${gastadas + 1}/${MAX_REOPENS}` +
        (gastadas === 0 && reopens > 0 ? ` — la conexión duró ${Math.round(uptimeMs / 60000)} min, presupuesto reiniciado` : ''),
    };
  }

  // 4) NUNCA conectamos en este proceso Y hay sesión vinculada ⇒ es un RECHAZO (405), no un
  //    cable. Esta rama es la del softban del 2026-07-28 y NO cambia: sale siempre, sin
  //    importar el flag ni el código, para que entrypoint.sh espacie el reintento.
  //    Los tests la fijan explícitamente, incluso para 428 — un 428 antes de haber conectado
  //    nunca es "se cayó el cable": es WhatsApp cerrándonos la puerta.
  if (hasCreds)
    return {
      action: 'exit',
      code: 1,
      reason: `rechazo de WhatsApp (${statusCode}) con sesión vinculada: NO reintentar en caliente`,
    };

  // 5) Pairing genuino: sin credenciales, cada QR que expira cierra el socket. Acotado.
  if (pairingRetries + 1 > maxPairing)
    return { action: 'exit', code: 1, reason: `${maxPairing} intentos de vinculación sin éxito` };
  return {
    action: 'pair',
    waitMs: Math.min(3000 * 2 ** pairingRetries, 60000),
    reason: `esperando un QR nuevo (intento ${pairingRetries + 1}/${maxPairing})`,
  };
}
