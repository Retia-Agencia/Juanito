// src/calendly/reschedule-ai.js
// Fallback de IA para la fecha de una reagenda (§18.AC). Solo corre cuando el regex de
// reschedule-parse.js NO entendió: es la red de seguridad para el español suelto del
// closer ("pal viernes tipo 3 y media", "el otro martes a primera hora").
//
// Reglas de la casa: UNA llamada, modelo barato, timeout corto, y si algo falla degrada
// a 'none' → Juanito repregunta con ejemplos de formato. Nunca bloquea la respuesta al
// closer ni se cuelga esperando a la API.

import Anthropic from '@anthropic-ai/sdk';
import { validateReschedule, wallClockToUtc } from './reschedule-parse.js';

const MODEL = () =>
  process.env.CALENDLY_RESCHEDULE_MODEL || process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = () => Number(process.env.CALENDLY_RESCHEDULE_AI_TIMEOUT_MS || 8000);

let _client = null;
function client() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// Hora local en el TZ del negocio, en el formato que le damos a Claude como "ahora".
function localNow(nowMs, tz) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    dateStyle: 'short',
    timeStyle: 'short',
    hour12: false,
  }).format(new Date(nowMs));
}

const PROMPT = (text, nowLocal, tz) =>
  `Eres un extractor de fechas. Un closer de ventas acaba de decir cuándo reagendó una llamada con un prospecto.

Ahora mismo es ${nowLocal} (zona horaria ${tz}, formato AAAA-MM-DD HH:MM, 24h).
El closer escribió: "${text}"

Devuelve SOLO un objeto JSON, sin texto alrededor, sin markdown:
- Si dice una fecha y hora concretas: {"datetime":"AAAA-MM-DDTHH:MM","unknown":false}  (hora LOCAL de ${tz}, 24h)
- Si dice que todavía no hay fecha: {"datetime":null,"unknown":true}
- Si no se entiende o falta la hora: {"datetime":null,"unknown":false}

Reglas: la fecha SIEMPRE es futura. Las llamadas son en horario laboral, así que una hora ambigua ("a las 3") es de la tarde salvo que sea entre 7 y 11, que es de la mañana. No inventes una hora si el closer no la dijo.`;

// Devuelve el mismo contrato que parseRescheduleReply:
//   { kind: 'datetime', startUtc } | { kind: 'unknown_date' } |
//   { kind: 'invalid', reason } | { kind: 'none' }
export async function parseRescheduleWithAi(text, { nowMs = Date.now(), tz = 'America/Bogota' } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) return { kind: 'none' };
  try {
    const res = await client().messages.create(
      {
        model: MODEL(),
        max_tokens: 100,
        messages: [{ role: 'user', content: PROMPT(text, localNow(nowMs, tz), tz) }],
      },
      { timeout: TIMEOUT_MS() }
    );

    const raw = res.content?.find((b) => b.type === 'text')?.text || '';
    const json = raw.match(/\{[\s\S]*\}/);
    if (!json) return { kind: 'none' };
    const out = JSON.parse(json[0]);

    if (out.unknown) return { kind: 'unknown_date' };
    if (!out.datetime) return { kind: 'none' };

    // Claude devuelve hora LOCAL sin offset → la interpretamos en el TZ del negocio con
    // la misma aritmética que el parser determinista (nunca con el TZ del proceso).
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/.exec(String(out.datetime).trim());
    if (!m) return { kind: 'none' };
    const startUtc = wallClockToUtc(
      { y: +m[1], m: +m[2], d: +m[3], hh: +m[4], mm: +m[5] },
      tz
    );
    if (Number.isNaN(startUtc.getTime())) return { kind: 'none' };
    return validateReschedule(startUtc, nowMs);
  } catch (e) {
    console.warn('[Calendly] fallback IA de reagenda falló:', e.message);
    return { kind: 'none' };
  }
}
