// src/index.js
// Entry point — arranca Express, webhooks, scheduler

import 'dotenv/config';
import express from 'express';
import { handleBossMessage, handleGroupMessage } from './bot/index.js';
import { parseIncomingMessage, verifyWebhook } from './meta/index.js';
import { parseOpenWAMessage, registerWebhook, checkSession } from './openwa/index.js';
import { startAllJobs } from './scheduler/index.js';
import { verifyMetaSignature, verifyHmacSignature } from './common/utils.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Capturar el raw body para verificación de firmas HMAC
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

// ─── Webhook de Meta (número del bot) ─────────────────────────────────────────

// GET: verificación inicial de Meta
app.get('/webhook/meta', (req, res) => {
  const { valid, challenge } = verifyWebhook(req.query);
  if (valid) return res.send(challenge);
  res.sendStatus(403);
});

// POST: mensajes entrantes del jefe
app.post('/webhook/meta', async (req, res) => {
  // Verificar firma de Meta si hay app secret configurado
  const sig = req.get('x-hub-signature-256');
  if (!verifyMetaSignature(req.rawBody, sig, process.env.META_APP_SECRET)) {
    console.warn('[Meta] Firma inválida, rechazando webhook');
    return res.sendStatus(401);
  }

  res.sendStatus(200); // Meta requiere 200 inmediato

  const msg = parseIncomingMessage(req.body);
  if (!msg) return;

  await handleBossMessage(msg).catch((e) =>
    console.error('[Meta] Error en handler:', e.message)
  );
});

// ─── Webhook de OpenWA (número del jefe, lectura de grupos) ───────────────────

app.post('/webhook/openwa', async (req, res) => {
  // Verificar firma HMAC de OpenWA
  const sig = req.get('x-webhook-signature') || req.get('x-hub-signature-256');
  const secret = process.env.OPENWA_WEBHOOK_SECRET || process.env.META_VERIFY_TOKEN;
  if (secret && !verifyHmacSignature(req.rawBody, sig, secret)) {
    console.warn('[OpenWA] Firma inválida, rechazando webhook');
    return res.sendStatus(401);
  }

  res.sendStatus(200); // OpenWA también requiere 200 inmediato

  const msg = parseOpenWAMessage(req.body);
  if (!msg) return;

  await handleGroupMessage(msg).catch((e) =>
    console.error('[OpenWA] Error en handler:', e.message)
  );
});

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ─── Arranque ─────────────────────────────────────────────────────────────────

async function bootstrap() {
  // Verificar sesión de OpenWA (no bloqueante)
  const sessionOk = await checkSession().catch(() => false);
  if (!sessionOk) {
    console.warn(
      '[Boot] ⚠️  OpenWA no está conectado — los grupos no llegarán hasta que conectes el número del jefe'
    );
  }

  // Registrar webhook en OpenWA apuntando a este servidor
  const publicUrl = process.env.PUBLIC_URL;
  if (publicUrl && sessionOk) {
    await registerWebhook(`${publicUrl}/webhook/openwa`).catch((e) =>
      console.error('[Boot] No se pudo registrar webhook de OpenWA:', e.message)
    );
  } else if (!publicUrl) {
    console.warn('[Boot] ⚠️  PUBLIC_URL no definida — registra el webhook de OpenWA manualmente');
  }

  // Arrancar scheduler
  startAllJobs();

  // Arrancar servidor
  app.listen(PORT, () => {
    console.log(`\n🚀 Second Brain Agent corriendo en puerto ${PORT}`);
    console.log(`   Webhook Meta:   POST /webhook/meta`);
    console.log(`   Webhook OpenWA: POST /webhook/openwa`);
    console.log(`   Health:         GET  /health\n`);
  });
}

// Manejo de errores no capturados para que el proceso no muera silenciosamente
process.on('unhandledRejection', (reason) => {
  console.error('[Fatal] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Fatal] Uncaught exception:', err);
});

bootstrap().catch((err) => {
  console.error('Error fatal al arrancar:', err);
  process.exit(1);
});
