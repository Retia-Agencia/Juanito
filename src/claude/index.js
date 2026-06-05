// src/claude/index.js
// Lógica de llamadas a Claude con memoria, contexto y tool use.
// La ejecución de las herramientas vive aquí dentro (handlers internos), no en el bot.

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
const MAX_TOKENS = Number(process.env.CLAUDE_MAX_TOKENS || 2048);

// ─── Seam de dependencias (Track A) ───────────────────────────────────────────
// Consumimos el contrato del Track A (db/index.js, contacts/index.js) + whatsapp.
// Hasta SYNC 1 esos símbolos pueden no existir todavía, así que los resolvemos
// de forma perezosa y permitimos inyectarlos en tests (sin tocar package.json).

let _injectedDeps = null;

// Solo para tests: sustituye las dependencias externas por mocks del contrato.
export function __setDeps(deps) {
  _injectedDeps = deps;
}
export function __resetDeps() {
  _injectedDeps = null;
}

async function resolveDeps() {
  if (_injectedDeps) return _injectedDeps;
  const [db, contacts, whatsapp] = await Promise.all([
    import('../db/index.js'),
    import('../contacts/index.js'),
    import('../whatsapp/index.js'),
  ]);
  return {
    // db
    saveMessage: db.saveMessage,
    getRecentHistory: db.getRecentHistory,
    saveReminder: db.saveReminder,
    getUpcomingReminders: db.getUpcomingReminders,
    setMemory: db.setMemory,
    getAllMemory: db.getAllMemory,
    saveSummary: db.saveSummary,
    getRecentSummaries: db.getRecentSummaries,
    searchMessages: db.searchMessages,
    searchMemory: db.searchMemory,
    searchSummaries: db.searchSummaries,
    // contacts
    resolveContact: contacts.resolveContact,
    // whatsapp
    resolveGroupByName: whatsapp.resolveGroupByName,
    getRecentMessages: whatsapp.getRecentMessages,
    // claude (mismo módulo)
    summarizeGroupMessages,
  };
}

// ─── Definición de herramientas (tool use, no parsing de JSON frágil) ─────────

const TOOLS = [
  {
    name: 'create_reminder',
    description:
      'Crea un recordatorio. Úsalo cuando el jefe pida que le recuerdes algo, o que le recuerdes algo a otra persona, en una fecha/hora específica.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Qué recordar, en lenguaje natural' },
        due_at: {
          type: 'string',
          description: 'Fecha y hora en formato YYYY-MM-DD HH:MM:SS, en la zona horaria del jefe',
        },
        recipient: {
          type: 'string',
          description:
            'Opcional. Nombre o número de la persona a la que va dirigido el recordatorio. ' +
            'Si se omite, el recordatorio es para el propio jefe.',
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
  {
    name: 'summarize_group',
    description:
      'Lee y resume lo que pasó recientemente en un grupo de WhatsApp del jefe, por nombre. ' +
      'Úsalo cuando el jefe pregunte "¿qué pasó en el grupo X?" o pida un resumen de un grupo.',
    input_schema: {
      type: 'object',
      properties: {
        group_name: {
          type: 'string',
          description: 'Nombre (o parte del nombre) del grupo a resumir',
        },
        period: {
          type: 'string',
          description:
            'Período a resumir en lenguaje natural: "hoy", "ayer", "semana", "24h". ' +
            'Si se omite, se asume las últimas 24 horas.',
        },
      },
      required: ['group_name'],
    },
  },
  {
    name: 'search_knowledge',
    description:
      'Busca en todo lo que el agente recuerda: historial de conversaciones, memoria de ' +
      'largo plazo y resúmenes de grupos. Úsalo cuando el jefe pregunte por algo que ya se ' +
      'habló o se guardó antes ("¿qué te dije sobre...?", "¿cuándo quedamos en...?").',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Qué buscar, en lenguaje natural' },
        since_days: {
          type: 'number',
          description: 'Opcional. Cuántos días hacia atrás buscar en el historial (default 30).',
        },
      },
      required: ['query'],
    },
  },
];

// ─── Prompt de sistema ────────────────────────────────────────────────────────

async function buildSystemPrompt(deps) {
  const now = new Date().toLocaleString('es-CO', {
    timeZone: process.env.TZ || 'America/Bogota',
    dateStyle: 'full',
    timeStyle: 'short',
  });

  const memory = (await deps.getAllMemory?.()) || [];
  const summaries = (await deps.getRecentSummaries?.(5)) || [];
  const reminders = (await deps.getUpcomingReminders?.(48)) || [];

  const memoryBlock = memory.length
    ? `## Lo que recuerdo\n${memory.map((m) => `- ${m.key}: ${m.value}`).join('\n')}`
    : '';

  const summaryBlock = summaries.length
    ? `## Resumen reciente de grupos\n${summaries
        .map((s) => `- [${s.chat_name || s.chatName || s.group_name || '?'}] ${s.summary}`)
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

Tienes estas herramientas; úsalas en vez de inventar formatos de texto, y luego
confirma al jefe en una línea natural:
- create_reminder: crea recordatorios. Si el jefe quiere recordarle algo a OTRA
  persona, pasa su nombre o número en "recipient". Si no logro identificar a esa
  persona, te lo diré por el resultado de la herramienta: en ese caso pídele al
  jefe que aclare el contacto en vez de inventar.
- summarize_group: lee y resume un grupo por nombre cuando pregunte qué pasó ahí.
- search_knowledge: busca en historial, memoria y resúmenes lo que ya se habló.
- save_memory: guarda hechos permanentes.

Cuando calcules la fecha de un recordatorio, usa la fecha y hora actual de arriba
como referencia (ej: "mañana a las 9" = el día siguiente a las 09:00:00).

${memoryBlock}
${summaryBlock}
${remindersBlock}`.trim();
}

// ─── Helpers de período para summarize_group ──────────────────────────────────

function formatDatetime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`;
}

function parsePeriod(period) {
  const now = new Date();
  const start = new Date(now);
  const p = (period || '').toLowerCase();

  if (/(semana|week|7)/.test(p)) {
    start.setDate(start.getDate() - 7);
  } else if (/(hoy|today)/.test(p)) {
    start.setHours(0, 0, 0, 0);
  } else if (/(ayer|yesterday)/.test(p)) {
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
  } else {
    start.setHours(start.getHours() - 24); // default: últimas 24h
  }

  return { periodStart: formatDatetime(start), periodEnd: formatDatetime(now) };
}

// ─── Handlers de herramientas (ejecución interna) ─────────────────────────────
// Exportado para tests: ejecuta una herramienta con dependencias inyectadas y
// devuelve el string que se manda como tool_result a Claude.

export async function dispatchTool({ name, input }, deps, ctx = {}) {
  switch (name) {
    case 'create_reminder': {
      const recipient = input.recipient?.trim();
      let toPhone = ctx.createdBy; // por defecto, el recordatorio es para el jefe
      let forName = null;

      if (recipient) {
        const contact = await deps.resolveContact(recipient);
        if (!contact) {
          return (
            `No encontré ningún contacto que coincida con "${recipient}". ` +
            `Pídele al jefe el número o el nombre exacto antes de crear el recordatorio.`
          );
        }
        toPhone = contact.phone;
        forName = contact.name;
      }

      await deps.saveReminder({
        text: input.text,
        dueAt: input.due_at,
        toPhone,
        createdBy: ctx.createdBy,
      });

      return forName
        ? `Recordatorio creado para ${forName} (${toPhone}) el ${input.due_at}: "${input.text}".`
        : `Recordatorio creado para el ${input.due_at}: "${input.text}".`;
    }

    case 'save_memory': {
      await deps.setMemory(input.key, input.value);
      return `Guardado en memoria: ${input.key}.`;
    }

    case 'summarize_group': {
      const group = await deps.resolveGroupByName(input.group_name);
      if (!group) {
        return (
          `No encontré ningún grupo que coincida con "${input.group_name}". ` +
          `Pídele al jefe el nombre exacto del grupo.`
        );
      }

      const { periodStart, periodEnd } = parsePeriod(input.period);
      const raw = (await deps.getRecentMessages(group.id, 50)) || [];
      const formatted = raw
        .filter((m) => m.body)
        .map((m) => `${m.sender?.pushname || m.sender?.id || '?'}: ${m.body}`)
        .join('\n');

      if (!formatted.trim()) {
        return `No hay mensajes recientes en "${group.name || group.id}" para resumir.`;
      }

      const summary = await deps.summarizeGroupMessages(group.name || group.id, formatted);

      await deps.saveSummary({
        chatId: group.id,
        chatName: group.name || group.id,
        summary,
        periodStart,
        periodEnd,
      });

      return `Resumen de "${group.name || group.id}" (${periodStart} → ${periodEnd}):\n${summary}`;
    }

    case 'search_knowledge': {
      const query = input.query;
      const sinceDays = input.since_days ?? 30;

      const [msgs, mem, sums] = await Promise.all([
        Promise.resolve(deps.searchMessages?.(query, sinceDays) || []),
        Promise.resolve(deps.searchMemory?.(query) || []),
        Promise.resolve(deps.searchSummaries?.(query) || []),
      ]);

      const parts = [];
      if (mem.length) {
        parts.push(
          `Memoria:\n${mem.map((m) => `- ${m.key}: ${m.value}`).join('\n')}`
        );
      }
      if (sums.length) {
        parts.push(
          `Resúmenes de grupos:\n${sums
            .map((s) => `- [${s.chat_name || s.chatName || '?'}] ${s.summary}`)
            .join('\n')}`
        );
      }
      if (msgs.length) {
        parts.push(
          `Conversaciones:\n${msgs.map((m) => `- ${m.role}: ${m.content}`).join('\n')}`
        );
      }

      return parts.length
        ? parts.join('\n\n')
        : `No encontré nada relacionado con "${query}".`;
    }

    default:
      return `Herramienta desconocida: ${name}.`;
  }
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
  const deps = await resolveDeps();
  const ctx = { createdBy: chatId };

  await deps.saveMessage({ role: 'user', content: userMessage, chatId });

  // getRecentHistory ya incluye el mensaje recién guardado como último 'user'
  const messages = sanitizeHistory(await deps.getRecentHistory(20));
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: userMessage });
  }

  const system = await buildSystemPrompt(deps);

  let response = await withRetry(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      tools: TOOLS,
      messages,
    })
  );

  // Loop de tool use: ejecutamos las herramientas aquí dentro hasta que Claude termine
  while (response.stop_reason === 'tool_use') {
    const toolResults = [];

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      let content;
      try {
        content = await dispatchTool(block, deps, ctx);
      } catch (err) {
        console.error(`[Claude] Error ejecutando ${block.name}:`, err.message);
        content = `La herramienta ${block.name} falló: ${err.message}`;
      }
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    response = await withRetry(() =>
      client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
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

  await deps.saveMessage({ role: 'assistant', content: finalText, chatId });

  return { text: finalText };
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
