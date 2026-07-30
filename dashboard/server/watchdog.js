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

const TZ = () => process.env.TZ || 'America/Bogota';
const INTERVALO_MIN = Number(process.env.DASH_WATCHDOG_MIN || 15);
const DEDUP_HORAS = Number(process.env.DASH_ALERT_DEDUP_HOURS || 6);
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
}

// ¿Ya avisamos de esto hace poco? Mismo criterio que shouldAlert() de
// src/calendly/health.js, pero persistido: acá sí sobrevive a un reinicio.
function yaAvisamos(dedupKey) {
  const row = db
    .prepare(
      `SELECT 1 FROM dash_alerts
        WHERE dedup_key = ? AND created_at > datetime('now', ?)
        LIMIT 1`
    )
    .get(dedupKey, `-${DEDUP_HORAS} hours`);
  return !!row;
}

// Una alerta AGREGADA por ciclo, nunca una por evento (advertencia explícita del
// handoff §18.AV).
export function evaluar() {
  const estado = salud();
  const problemas = estado.checks.filter((c) => c.level === 'error' || c.level === 'warn');
  if (!problemas.length) return { alertó: false, nivel: 'ok', problemas: [] };

  // La clave de dedup es el conjunto de checks en rojo, no su contenido: si aparece
  // un problema nuevo se avisa aunque los viejos sigan ahí.
  const dedupKey = problemas.map((p) => `${p.key}:${p.level}`).sort().join('|');
  if (yaAvisamos(dedupKey)) return { alertó: false, nivel: estado.nivel, problemas, dedup: true };

  const lineas = problemas.map((p) => {
    const icono = p.level === 'error' ? '🔴' : '🟡';
    return `${icono} ${p.label}: ${p.count} — ${p.detail}`;
  });
  const mensaje = `🚨 Juanito — revisión ${new Date().toLocaleString('sv', { timeZone: TZ() })}\n\n${lineas.join('\n')}`;

  db.prepare(
    `INSERT INTO dash_alerts (dedup_key, nivel, mensaje, enviado_wa) VALUES (?, ?, ?, ?)`
  ).run(dedupKey, estado.nivel, mensaje, WHATSAPP_ON ? 1 : 0);

  if (WHATSAPP_ON) {
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

  console.log(
    `[Dash] alerta ${estado.nivel} (${problemas.length} problema(s))` +
      (WHATSAPP_ON ? ' → encolada a WhatsApp' : ' → solo dashboard')
  );
  return { alertó: true, nivel: estado.nivel, problemas, mensaje };
}

export function historial(limite = 50) {
  return db
    .prepare(`SELECT * FROM dash_alerts ORDER BY created_at DESC LIMIT ?`)
    .all(limite);
}

export function start() {
  initSchema();
  const tick = () => {
    try {
      evaluar();
    } catch (err) {
      // Nunca dejar que el watchdog tumbe el server.
      console.error('[Dash] watchdog falló:', err.message);
    }
  };
  tick();
  setInterval(tick, INTERVALO_MIN * 60000).unref();
  console.log(
    `[Dash] watchdog cada ${INTERVALO_MIN} min · WhatsApp ${WHATSAPP_ON ? 'ON' : 'OFF (solo dashboard)'}`
  );
}
