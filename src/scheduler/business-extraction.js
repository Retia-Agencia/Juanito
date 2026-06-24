// src/scheduler/business-extraction.js
// Cron de extracción de contexto de negocio (Fase 2B). Lee los resúmenes de grupos que Juanito
// ya genera, pide a Claude hechos DURADEROS del negocio que aún no conoce, y los guarda como
// PROPUESTOS (status='proposed'). Nada se activa solo: un admin los confirma con /negocio ok.
//
// Por qué resúmenes y no mensajes crudos: más limpio, más barato en tokens y mucha menos
// superficie de inyección de prompts (los resúmenes ya pasaron por el modelo).

import { CronJob } from 'cron';
import {
  getRecentSummaries,
  listBusinessContext,
  listProposedBusinessFacts,
  createBusinessFact,
} from '../db/index.js';
import { extractBusinessFacts } from '../claude/index.js';
import { approvalsTarget } from '../common/approval-routing.js';
import { sendMessage } from '../whatsapp/index.js';

const TZ = () => process.env.TZ || 'America/Bogota';
// Diario 3am por defecto: corre una vez al día, después de acumular resúmenes y en hora muerta.
const CRON = () => process.env.BIZ_EXTRACT_CRON || '0 3 * * *';
const MAX_SUMMARIES = () => Number(process.env.BIZ_EXTRACT_SUMMARIES || 20);

// ─── Una pasada de extracción (exportada para tests / disparo manual) ─────────

export async function runBusinessExtractionCycle() {
  const summaries = getRecentSummaries(MAX_SUMMARIES());
  if (!summaries.length) return 0;

  // Dedup contra TODO lo que ya hay (activos + ya propuestos) para no proponer repetido.
  const existing = [...listBusinessContext(), ...listProposedBusinessFacts()];
  const facts = await extractBusinessFacts(summaries, existing);
  if (!facts.length) return 0;

  for (const f of facts) {
    createBusinessFact({ topic: f.topic, fact: f.fact, status: 'proposed', source: 'chat', createdBy: null });
  }
  console.log(`[Scheduler] Negocio: ${facts.length} hecho(s) propuesto(s) desde los resúmenes.`);

  // Aviso best-effort al equipo para que los revise. Un fallo de envío no rompe la extracción.
  try {
    const target = await approvalsTarget();
    if (target) {
      await sendMessage(
        target,
        `🧠 Detecté ${facts.length} posible(s) hecho(s) del negocio en los chats. Revísalos: /negocio pendientes`
      );
    }
  } catch {
    /* el aviso es best-effort; las propuestas ya quedaron guardadas */
  }

  return facts.length;
}

// ─── Job: extraer contexto de negocio periódicamente ──────────────────────────

export function startBusinessExtractionJob() {
  // Necesita el modelo para extraer. Sin API key, se autodesactiva (no rompe el arranque).
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[Scheduler] Extracción de negocio desactivada (sin ANTHROPIC_API_KEY)');
    return;
  }
  new CronJob(
    CRON(),
    async () => {
      console.log('[Scheduler] Extrayendo contexto de negocio de los resúmenes...');
      await runBusinessExtractionCycle();
    },
    null,
    true,
    TZ()
  );
  console.log('[Scheduler] Job de extracción de contexto de negocio activo ✅');
}
