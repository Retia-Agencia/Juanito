// src/calendly/optin.js
// Registro (opt-in) de closers. Práctica anti-baneo: Juanito NUNCA inicia una
// conversación con un closer. El closer le escribe primero → su número queda
// registrado → recién entonces el bot puede mandarle los pushes precall.
//
// Esto se dispara desde src/index.js para DMs que NO son del jefe.

import { resolveCloserByPhone, resolveCloserByPushName, isNonCanonicalOptinJid } from './closers.js';
import { registerOptin, isOptedIn, markIfNew } from '../db/index.js';
import { sendMessage } from '../whatsapp/index.js';
import { normalizePhone, maskJid } from '../common/utils.js';
import { approvalsTarget } from '../common/approval-routing.js';

// Devuelve true si manejó el mensaje (era un closer), false si no.
// `pushName` es el nombre WA del remitente: fallback para cuando `from` es un @lid
// no resuelto a teléfono (WA multi-device). La respuesta se envía a `from` (el @lid
// también es enrutable por Baileys); el opt-in se guarda por el teléfono canónico
// del closer (no por el @lid) para que delivery funcione correctamente.
export async function handleCloserOptin({ from, pushName, messageId }) {
  let closer = resolveCloserByPhone(from);
  if (!closer && pushName) {
    closer = resolveCloserByPushName(pushName);
    if (closer) console.log(`[Calendly] Closer resuelto por pushName "${pushName}" → ${closer.name}`);
  }
  if (!closer) return false; // no es un closer conocido → ignorar (no responder a desconocidos)

  // Dedup del mensaje entrante
  if (messageId && !markIfNew(messageId)) return true;

  const yaEstaba = isOptedIn(closer.phone);
  // source:'self' → opt-in GANADO (el closer escribió): habilita el envío. Guardamos
  // el JID desde el que escribió (auditoría; puede ser un @lid sin resolver).
  registerOptin({ phone: closer.phone, closerEmail: closer.email, name: closer.name, source: 'self', contactJid: from });

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

  return true;
}
