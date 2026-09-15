// dashboard/server/watchdog.js
// Vigilancia periódica: revisa los checks de salud y avisa. Vive en el DASHBOARD,
// no en el bot — así no hay una línea de código nueva dentro del crash domain de
// Baileys (garantía 3 de docs/DASHBOARD-ROADMAP.md).
//
// El canal de salida es la tabla `reminders` usada como OUTBOX: el cron de
// recordatorios del bot corre cada minuto, está siempre encendido, y ya despacha a
// `to_phone` por la cola anti-ban. Insertamos una fila y el mensaje sale solo, sin
// socket de WhatsApp acá y sin tocar el bot.
//
// El texto se redacta sabiendo que src/scheduler/reminders.js:24 lo prefija con
// "⏰ Recordatorio: ". Por eso las alertas empiezan con 🚨 y el nombre del sistema.
//
// Arranca SIN mandar WhatsApp (DASH_ALERTS_WHATSAPP=false). El handoff §18.AV avisa
// que estas alertas compiten con el anti-ban y con la paciencia de quien las lee:
// primero se mide el volumen mirando el dashboard, después se enciende el canal.

import db, { saveReminder } from '../../src/db/index.js';
import { salud } from './queries.js';
import { enviarTelegram, telegramConfigurado } from './notify.js';

const TZ = () => process.env.TZ || 'America/Bogota';
const INTERVALO_MIN = Number(process.env.DASH_WATCHDOG_MIN || 15);
const DEDUP_HORAS = Number(process.env.DASH_ALERT_DEDUP_HOURS || 6);
// Una caída del bot se repite mucho más seguido que un problema normal: 6 horas de silencio
// sobre "Juanito está caído" es exactamente el agujero que este watchdog viene a tapar.
const DEDUP_HORAS_CRITICO = Number(process.env.DASH_ALERT_DEDUP_CRITICO_HORAS || 1);
const WHATSAPP_ON = process.env.DASH_ALERTS_WHATSAPP === 'true'; // default: solo dashboard

const adminJids = () =>
  (process.env.ADMIN_LID || '').split(',').map((s) => s.trim()).filter(Boolean);

// Tabla propia del dashboard. Se crea acá y NO en src/db/migrate.js: ese archivo
// corre en `entrypoint.sh` antes del bot (`migrate && index`), así que una migración
// que falle deja al bot sin arrancar. Esto no puede tener ese poder.
export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dash_alerts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      dedup_key   TEXT NOT NULL,
      nivel       TEXT NOT NULL,
      mensaje     TEXT NOT NULL,
      enviado_wa  INTEGER NOT NULL DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_dash_alerts_key ON dash_alerts (dedup_key, created_at);
  `);
  // Columna agregada después (canal fuera de banda). ALTER idempotente a mano porque SQLite no
  // tiene "ADD COLUMN IF NOT EXISTS": si ya está, tira error y lo ignoramos. Mismo criterio que
  // el resto del esquema del dashboard — esto no puede impedir que el server arranque.
  try {
    db.exec(`ALTER TABLE dash_alerts ADD COLUMN enviado_tg INTEGER NOT NULL DEFAULT 0`);
  } catch {
    /* ya existía */
  }
}

// ¿Ya avisamos de esto hace poco? Mismo criterio que shouldAlert() de
// src/calendly/health.js, pero persistido: acá sí sobrevive a un reinicio.
function yaAvisamos(dedupKey, horas = DEDUP_HORAS) {
  const row = db
    .prepare(
      `SELECT 1 FROM dash_alerts
        WHERE dedup_key = ? AND created_at > datetime('now', ?)
        LIMIT 1`
    )
    .get(dedupKey, `-${horas} hours`);
  return !!row;
}

// Una alerta AGREGADA por ciclo, nunca una por evento (advertencia explícita del
// handoff §18.AV).
export async function evaluar() {
  const estado = salud();
  const problemas = estado.checks.filter((c) => c.level === 'error' || c.level === 'warn');
  if (!problemas.length) return { alertó: false, nivel: 'ok', problemas: [] };

  // ¿El bot está mudo? Cambia DOS cosas, y por eso se calcula antes que nada:
  //  1) El canal de WhatsApp no sirve — su outbox es justo lo que no se está drenando.
  //  2) El dedup largo no aplica: una caída hay que repetirla hasta que alguien la atienda.
  const botCaido = problemas.some((p) => p.key === 'agente_mudo');

  // La clave de dedup es el conjunto de checks en rojo, no su contenido: si aparece
  // un problema nuevo se avisa aunque los viejos sigan ahí.
  const dedupKey = problemas.map((p) => `${p.key}:${p.level}`).sort().join('|');
  const ventana = botCaido ? DEDUP_HORAS_CRITICO : DEDUP_HORAS;
  if (yaAvisamos(dedupKey, ventana))
    return { alertó: false, nivel: estado.nivel, problemas, dedup: true };

  const lineas = problemas.map((p) => {
    const icono = p.level === 'error' ? '🔴' : '🟡';
    return `${icono} ${p.label}: ${p.count} — ${p.detail}`;
  });
  const encabezado = botCaido
    ? '🚨🚨 JUANITO CAÍDO — no está despachando mensajes'
    : '🚨 Juanito — revisión';
  const mensaje =
    `${encabezado} ${new Date().toLocaleString('sv', { timeZone: TZ() })}\n\n${lineas.join('\n')}` +
    (botCaido
      ? '\n\nRevisá: docker ps -a | grep juanito-agent · docker logs --tail 50 juanito-agent\n' +
        'Si dice 401/device_removed hay que re-vincular por QR desde IP residencial ' +
        '(docs/WHATSAPP-PAIRING.md). NO dejarlo reiniciando en loop.'
      : '');

  // WhatsApp se saltea cuando el bot está caído: la fila quedaría 'pending' sin despachar y, si
  // el bot vuelve horas después, entregaría una alerta vieja de algo ya resuelto. Ruido puro.
  const usarWhatsapp = WHATSAPP_ON && !botCaido;
  const tgOk = await enviarTelegram(mensaje);

  db.prepare(
    `INSERT INTO dash_alerts (dedup_key, nivel, mensaje, enviado_wa, enviado_tg) VALUES (?, ?, ?, ?, ?)`
  ).run(dedupKey, estado.nivel, mensaje, usarWhatsapp ? 1 : 0, tgOk ? 1 : 0);

  if (usarWhatsapp) {
    const destinos = adminJids();
    if (!destinos.length) {
      console.warn('[Dash] DASH_ALERTS_WHATSAPP=true pero no hay ADMIN_LID configurado');
    }
    // due_at es hora LOCAL en esta tabla (ver localNow() en src/db/index.js).
    const ahora = new Date().toLocaleString('sv', { timeZone: TZ() });
    for (const jid of destinos) {
      saveReminder({ text: mensaje, dueAt: ahora, toPhone: jid, createdBy: 'dashboard' });
    }
  }

  // Que el bot esté caído Y Telegram no esté configurado es el peor de los casos: nadie se va a
  // enterar. Se grita en el log del dashboard, que es lo único que queda.
  if (botCaido && !tgOk) {
    console.error(
      '[Dash] ⚠️ BOT CAÍDO y la alerta NO salió por ningún canal' +
        (telegramConfigurado() ? ' (Telegram falló)' : ' (Telegram sin configurar)')
    );
  }

  const canales = [usarWhatsapp && 'WhatsApp', tgOk && 'Telegram'].filter(Boolean);
  console.log(
    `[Dash] alerta ${estado.nivel} (${problemas.length} problema(s))` +
      (canales.length ? ` → ${canales.join(' + ')}` : ' → solo dashboard')
  );
  return { alertó: true, nivel: estado.nivel, problemas, mensaje, telegram: tgOk };
}

export function historial(limite = 50) {
  return db
    .prepare(`SELECT * FROM dash_alerts ORDER BY created_at DESC LIMIT ?`)
    .all(limite);
}

export function start() {
  initSchema();
  // `evaluar` es async desde que manda Telegram. El catch va sobre la promesa además del
  // try/catch sincrónico: un rejection sin manejar acá tumbaría el proceso del dashboard, que
  // es justo el que tiene que seguir vivo cuando todo lo demás se cae.
  const tick = () => {
    try {
      evaluar().catch((err) => console.error('[Dash] watchdog falló:', err.message));
    } catch (err) {
      console.error('[Dash] watchdog falló:', err.message);
    }
  };
  tick();
  setInterval(tick, INTERVALO_MIN * 60000).unref();
  console.log(
    `[Dash] watchdog cada ${INTERVALO_MIN} min · WhatsApp ${WHATSAPP_ON ? 'ON' : 'OFF (solo dashboard)'}` +
      ` · Telegram ${telegramConfigurado() ? 'ON' : 'OFF (sin TELEGRAM_BOT_TOKEN/CHAT_ID)'}`
  );
}
