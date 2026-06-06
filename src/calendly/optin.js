// src/calendly/optin.js
// Registro (opt-in) de closers. Práctica anti-baneo: Juanito NUNCA inicia una
// conversación con un closer. El closer le escribe primero → su número queda
// registrado → recién entonces el bot puede mandarle los pushes precall.
//
// Esto se dispara desde src/index.js para DMs que NO son del jefe.

import { resolveCloserByPhone } from './closers.js';
import { registerOptin, isOptedIn, markIfNew } from '../db/index.js';
import { sendMessage } from '../whatsapp/index.js';

// Devuelve true si manejó el mensaje (era un closer), false si no.
export async function handleCloserOptin({ from, messageId }) {
  const closer = resolveCloserByPhone(from);
  if (!closer) return false; // no es un closer conocido → ignorar (no responder a desconocidos)

  // Dedup del mensaje entrante
  if (messageId && !markIfNew(messageId)) return true;

  const yaEstaba = isOptedIn(closer.phone);
  registerOptin({ phone: closer.phone, closerEmail: closer.email, name: closer.name });

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
