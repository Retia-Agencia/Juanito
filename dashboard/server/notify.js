// dashboard/server/notify.js
// Aviso FUERA DE BANDA del watchdog. Existe por una razón puntual:
//
// El canal de salida del watchdog es la tabla `reminders` → el cron del bot → la cola
// anti-ban. Ese canal es bueno para casi todo, pero tiene un punto ciego exacto: **cuando el
// que está caído es el bot, la alerta no sale.** La fila queda 'pending' y nadie la despacha.
// O sea, el watchdog no puede avisar justo de lo único que nadie más va a notar.
//
// Pasó el 2026-09-14: a las 18:51 WhatsApp cerró la sesión con `conflict / device_removed`
// (alguien desvinculó el dispositivo desde el teléfono). Juanito estuvo 2 horas caído y se
// supo porque un closer lo reportó. `pushesVencidos()` lo habría marcado en rojo a los ~35
// min, pero la alerta no tenía por dónde salir.
//
// Telegram se eligió porque es el canal que NO comparte modo de falla con lo que vigila: no
// depende de WhatsApp, ni de Meta, ni de la sesión de Baileys, ni del proceso del bot. Solo
// necesita HTTPS saliente desde el contenedor del dashboard.
//
// Se AUTODESACTIVA sin `TELEGRAM_BOT_TOKEN` o `TELEGRAM_CHAT_ID`, igual que todos los jobs del
// scheduler: que falte la config nunca puede romper el arranque del dashboard.

import { fetchConDeadline } from '../../src/common/http.js';

const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = () => process.env.TELEGRAM_CHAT_ID || '';

export const telegramConfigurado = () => !!(TOKEN() && CHAT_ID());

// Telegram corta los mensajes en 4096 caracteres. Un digest de alertas largo llegaría
// truncado por el servidor y sin aviso; preferimos recortar nosotros y decirlo.
const LIMITE = 3900;

function recortar(texto) {
  if (texto.length <= LIMITE) return texto;
  return `${texto.slice(0, LIMITE)}\n\n… (recortado, mirá el dashboard)`;
}

// Best-effort por contrato: esto es el canal de EMERGENCIA, y si falla no puede tumbar el
// watchdog ni el server. Devuelve true/false para que el caller lo registre, nunca lanza.
//
// ⚠️ Sin `parse_mode`. El texto de las alertas trae nombres de closers, correos y motivos de
//    skip — cualquiera de esos puede tener un `_` o un `*` y Markdown lo rechazaría entero
//    con 400. Texto plano siempre entrega.
export async function enviarTelegram(mensaje) {
  if (!telegramConfigurado()) return false;
  try {
    const res = await fetchConDeadline(
      `https://api.telegram.org/bot${TOKEN()}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID(),
          text: recortar(mensaje),
          disable_web_page_preview: true,
        }),
      },
      { timeoutMs: 10000 }
    );
    if (!res.ok) {
      const cuerpo = await res.text().catch(() => '');
      console.error(`[Dash] Telegram respondió ${res.status}: ${cuerpo.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[Dash] Telegram falló:', err.message);
    return false;
  }
}
