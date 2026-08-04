// src/calendly/optin.js
// Registro (opt-in) de closers. Práctica anti-baneo: Juanito NUNCA inicia una
// conversación con un closer. El closer le escribe primero → su número queda
// registrado → recién entonces el bot puede mandarle los pushes precall.
//
// Esto se dispara desde src/index.js para DMs que NO son del jefe.

import { resolveCloserByPhone, resolveCloserByLid, resolveCloserByPushName, isNonCanonicalOptinJid, workLidForCloser } from './closers.js';
import { registerOptin, isOptedIn, markIfNew } from '../db/index.js';
import { sendMessage } from '../whatsapp/index.js';
import { normalizePhone, maskJid } from '../common/utils.js';
import { approvalsTarget } from '../common/approval-routing.js';

// Devuelve true si CONSUMIÓ el mensaje (era un closer), false si no.
// `pushName` es el nombre WA del remitente: fallback para cuando `from` es un @lid
// no resuelto a teléfono (WA multi-device). La respuesta se envía a `from` (el @lid
// también es enrutable por Baileys); el opt-in se guarda por el teléfono canónico
// del closer (no por el @lid) para que delivery funcione correctamente.
//
// ⚠️ El valor de retorno NO es "era su primer mensaje": es true para TODO mensaje de un
// closer conocido, ya registrado o no. El router lo usa como "no sigas bajando".
//
// `consume: false` → registra igual (que es lo que re-pinea el contact_jid, o sea a dónde
// salen los pushes) pero NI consume el mensaje NI reclama el dedup, porque abajo hay OTRO
// handler que va a atender ese mismo mensaje: el contexto agéntico del closer (§18.AZ).
// Si reclamara el dedup, el de abajo vería el mensaje como duplicado y no respondería nunca.
export async function handleCloserOptin({ from, pushName, messageId, consume = true }) {
  let closer = resolveCloserByPhone(from);
  // LID de trabajo conocido (CLOSER_LIDS): recupera a quien escribe desde un @lid que no mapea a su
  // teléfono y cuyo pushName no permite el match (ej: Sebas). Reconocerlo aquí AUTOCORRIGE su opt-in.
  if (!closer) {
    closer = resolveCloserByLid(from);
    if (closer) console.log(`[Calendly] Closer resuelto por LID conocido → ${closer.name}`);
  }
  if (!closer && pushName) {
    closer = resolveCloserByPushName(pushName);
    if (closer) console.log(`[Calendly] Closer resuelto por pushName "${pushName}" → ${closer.name}`);
  }
  if (!closer) return false; // no es un closer conocido → ignorar (no responder a desconocidos)

  // Dedup del mensaje entrante. En modo `consume:false` NO se reclama: el slot es del
  // handler que de verdad va a responder. Una entrega duplicada de Baileys vuelve a pasar
  // por acá, pero registerOptin es idempotente y el saludo solo sale si `!yaEstaba` —que en
  // la segunda pasada ya es false—, así que no se duplica nada visible.
  if (consume && messageId && !markIfNew(messageId)) return true;

  const yaEstaba = isOptedIn(closer.phone);
  // source:'self' → opt-in GANADO (el closer escribió): habilita el envío.
  // contact_jid = destino REAL de los pushes. Para closers con LID de trabajo conocido
  // (CLOSER_LIDS) PINNEAMOS la entrega a ese LID en vez de a `from`: aunque escriban desde
  // otro dispositivo (ej: Sebas desde su personal, cuyo pushName matchea y haría driftear
  // el contact_jid al número equivocado), los pushes se quedan en el hilo de trabajo. Esto
  // ELIMINA de raíz el bug recurrente "pushes al personal". Sin LID de trabajo mapeado,
  // se usa `from` como antes (mejor esfuerzo).
  const workJid = workLidForCloser(closer.email);
  const contactJid = workJid || from;
  registerOptin({ phone: closer.phone, closerEmail: closer.email, name: closer.name, source: 'self', contactJid });

  // Hardening anti "pushes al número equivocado" (bug Sebas): si el closer se registró desde un
  // número de TELÉFONO distinto al canónico de trabajo, el contact_jid (destino de los pushes)
  // apunta al número incorrecto. No sabemos cuál es el bueno, así que lo dejamos pasar pero lo
  // marcamos en logs y avisamos al equipo una vez (en el primer registro) para que lo corrija.
  if (isNonCanonicalOptinJid(closer.phone, from)) {
    console.warn(
      `[Calendly] ⚠️ ${closer.name} se registró desde un número NO canónico ${maskJid(from)} ` +
      `(trabajo: …${normalizePhone(closer.phone).slice(-4)}). Los pushes irán ahí hasta corregir el opt-in.`
    );
    if (!yaEstaba) {
      try {
        const target = await approvalsTarget();
        if (target) {
          await sendMessage(
            target,
            `⚠️ ${closer.name} se registró para los pushes precall desde un número que NO es el de ` +
            `trabajo (…${normalizePhone(from).slice(-4)}). Los recordatorios le llegarán ahí. Si no es ` +
            `el correcto, que escriba a Juanito desde su número de trabajo.`
          );
        }
      } catch {
        /* aviso best-effort: no rompe el opt-in */
      }
    }
  }

  if (!yaEstaba) {
    const nombre = closer.name.split(' ')[0];
    console.log(`[Calendly] Opt-in registrado: ${closer.name} (${closer.phone})`);
    // Responder a SU mensaje (acción segura: es una respuesta, no un mensaje en frío)
    await sendMessage(
      from,
      `¡Hola ${nombre}! Quedaste registrado ✅\n\nA partir de ahora te aviso por aquí cuándo mandarle los pushes precall a tus prospectos (Push 1 la noche anterior, Push 2 en la mañana, y Push 3 antes de cada llamada).`
    ).catch((e) => console.error('[Calendly] Error confirmando opt-in:', e.message));
  } else {
    console.log(`[Calendly] Closer ya registrado, mensaje recibido: ${closer.name}`);
  }

  return consume;
}
