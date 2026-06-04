// src/claude/index.js
// Lógica de llamadas a Claude con memoria, contexto y tool use

import Anthropic from '@anthropic-ai/sdk';
import {
  getRecentHistory,
  getRecentGroupContext,
  getAllMemory,
  getUpcomingReminders,
  saveMessage,
} from '../db/index.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
const MAX_TOKENS = Number(process.env.CLAUDE_MAX_TOKENS || 2048);

// ─── Definición de herramientas (tool use, no parsing de JSON frágil) ─────────

const TOOLS = [
  {
    name: 'create_reminder',
    description:
      'Crea un recordatorio para el jefe. Úsalo cuando pida que le recuerdes algo en una fecha/hora específica.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Qué recordar, en lenguaje natural' },
        due_at: {
          type: 'string',
          description: 'Fecha y hora en formato YYYY-MM-DD HH:MM:SS, en la zona horaria del jefe',
        },
      },
      required: ['text', 'due_at'],
    },
  },
  {
    name: 'save_memory',
    description:
      'Guarda un hecho en memoria de largo plazo. Úsalo cuando el jefe pida recordar algo permanente (datos, preferencias, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Identificador corto, ej: numero_cuenta' },
        value: { type: 'string', description: 'El valor a recordar' },
      },
      required: ['key', 'value'],
    },
  },
];

// ─── Prompt de sistema ────────────────────────────────────────────────────────

function buildSystemPrompt() {
  const now = new Date().toLocaleString('es-CO', {
    timeZone: process.env.TZ || 'America/Bogota',
    dateStyle: 'full',
    timeStyle: 'short',
  });

  const memory = getAllMemory();
  const groupContext = getRecentGroupContext(5);
  const reminders = getUpcomingReminders(48);

  const memoryBlock = memory.length
    ? `## Lo que recuerdo\n${memory.map((m) => `- ${m.key}: ${m.value}`).join('\n')}`
    : '';

  const groupBlock = groupContext.length
    ? `## Resumen reciente de grupos\n${groupContext
        .map((g) => `- [${g.group_name}] ${g.summary}`)
        .join('\n')}`
    : '';

  const remindersBlock = reminders.length
    ? `## Recordatorios próximos\n${reminders
        .map((r) => `- ${r.due_at}: ${r.text}`)
        .join('\n')}`
    : '';

  return `Eres un asistente personal inteligente que vive en WhatsApp.
Tu trabajo es ayudar al jefe con su día a día: recordatorios, resúmenes,
preguntas, tareas y lo que sea que necesite.

Fecha y hora actual: ${now}

Personalidad:
- Relajado y conversacional, como un colega de confianza.
- Directo — sin rodeos ni relleno innecesario.
- Respondes en el mismo idioma que te escribe el jefe.
- Nunca dices "¡Claro que sí!" ni frases de relleno de asistente genérico.
- Cuando no sabes algo, lo dices sin drama.

Para recordatorios y memoria usa las herramientas disponibles (create_reminder,
save_memory). No inventes formatos de texto para esto; llama a la herramienta y
confirma al jefe en una línea natural.

Cuando calcules la fecha de un recordatorio, usa la fecha y hora actual de arriba
como referencia (ej: "mañana a las 9" = el día siguiente a las 09:00:00).

${memoryBlock}
${groupBlock}
${remindersBlock}`.trim();
}

// ─── Sanitizar historial para cumplir reglas de la API ────────────────────────
// La API exige: primer mensaje = user, y roles alternados. Limpiamos eso.

function sanitizeHistory(history) {
  const cleaned = [];
  for (const msg of history) {
    if (!msg.content || !msg.content.trim()) continue; // descartar vacíos
    if (cleaned.length === 0 && msg.role !== 'user') continue; // primero debe ser user
    const last = cleaned[cleaned.length - 1];
    if (last && last.role === msg.role) {
      last.content += `\n${msg.content}`; // colapsar roles repetidos
    } else {
      cleaned.push({ role: msg.role, content: msg.content });
    }
  }
  return cleaned;
}

// ─── Reintentos con backoff para rate limits / errores transitorios ───────────

async function withRetry(fn, { retries = 3, baseDelay = 1000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.status;
      if (status && ![429, 500, 502, 503, 529].includes(status)) throw err;
      if (attempt === retries) break;
      const delay = baseDelay * 2 ** attempt + Math.random() * 500;
      console.warn(
        `[Claude] Reintento ${attempt + 1}/${retries} en ${Math.round(delay)}ms (status ${status})`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ─── Función principal ────────────────────────────────────────────────────────

export async function chat(userMessage, chatId = null) {
  saveMessage({ role: 'user', content: userMessage, chatId });

  // getRecentHistory ya incluye el mensaje recién guardado como último 'user'
  const messages = sanitizeHistory(getRecentHistory(20));
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: userMessage });
  }

  const collectedActions = { reminder: null, memory: null };

  let response = await withRetry(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(),
      tools: TOOLS,
      messages,
    })
  );

  // Loop de tool use: procesar herramientas hasta que Claude termine
  while (response.stop_reason === 'tool_use') {
    const toolResults = [];

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      if (block.name === 'create_reminder') {
        collectedActions.reminder = block.input;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'Recordatorio creado correctamente.',
        });
      } else if (block.name === 'save_memory') {
        collectedActions.memory = block.input;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'Guardado en memoria correctamente.',
        });
      }
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    response = await withRetry(() =>
      client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: buildSystemPrompt(),
        tools: TOOLS,
        messages,
      })
    );
  }

  const finalText =
    response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim() || 'Listo.';

  saveMessage({ role: 'assistant', content: finalText, chatId });

  return { text: finalText, reminder: collectedActions.reminder, memory: collectedActions.memory };
}

// ─── Resumir mensajes de grupo ────────────────────────────────────────────────

export async function summarizeGroupMessages(groupName, messages) {
  const response = await withRetry(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system:
        'Eres un asistente que resume conversaciones de WhatsApp de forma muy concisa. Responde solo con el resumen, sin introducción.',
      messages: [
        {
          role: 'user',
          content: `Resume en 2-3 líneas lo más importante de esta conversación del grupo "${groupName}":\n\n${messages}`,
        },
      ],
    })
  );

  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
