// src/setteo/setteo-ai.js
// Fallback de IA para el setteo dictado en español suelto (§18.AZ). Solo corre cuando el
// parser determinista de parse.js NO entendió. Mismo contrato y mismas reglas de la casa que
// calendly/reschedule-ai.js, que es de donde sale este patrón:
//   UNA llamada · modelo barato · timeout corto · si algo falla, degrada a 'none' y Juanito
//   repregunta. NUNCA bloquea la respuesta al closer ni se cuelga esperando a la API.
//
// Lo que este módulo NO hace, a propósito: inventar. Si el closer no nombró a nadie, la
// respuesta correcta es 'none' (pedir los nombres), no rellenar con "Lead 1, Lead 2" para
// cuadrar un número. La tabla de setteo alimenta una conversación sobre comisiones.

import Anthropic from '@anthropic-ai/sdk';
import { normalizeLeadName } from '../common/utils.js';
import { localDateISO, shiftDateISO } from './parse.js';

const MODEL = () =>
  process.env.SETTEO_AI_MODEL || process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = () => Number(process.env.SETTEO_AI_TIMEOUT_MS || 8000);
const ENABLED = () => process.env.SETTEO_AI_FALLBACK !== 'false';
const TZ = () => process.env.TZ || 'America/Bogota';

let _client = null;
function client() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const PROMPT = (text, hoy) =>
  `Eres un extractor de datos. Un closer de ventas acaba de contar por WhatsApp a qué leads le escribió (esto se llama "setteo") y cómo le fue con cada uno.

Hoy es ${hoy} (formato AAAA-MM-DD).
El closer escribió: "${text}"

Devuelve SOLO un objeto JSON, sin texto alrededor, sin markdown:
{"fecha":"AAAA-MM-DD","leads":[{"nombre":"...","contesto":true|false,"agendo":true|false,"vendio":true|false}]}

Reglas:
- "nombre" es el nombre del LEAD (el prospecto), nunca el del closer. Cópialo tal como lo escribió, sin corregir ni completar apellidos.
- Si NO menciona ningún nombre propio, devuelve {"leads":[]}. No inventes nombres ni rellenes para cuadrar una cantidad.
- contesto=true si el lead respondió algo. Si agendó o compró, entonces contesto también es true.
- agendo=true solo si quedó una reunión o llamada agendada.
- vendio=true solo si se cerró la venta.
- "quedó en pensarlo", "está interesado", "lo dejo en seguimiento" → contesto=true, agendo=false.
- "no contestó", "me dejó en visto", "ninguno respondió", "nada" → contesto=false.
- La fecha es la del setteo. Si no dice ninguna, usa hoy. Nunca una fecha futura.`;

// Devuelve el MISMO contrato que parseSetteoReply:
//   { kind: 'setteos', fecha, items: [{ leadName, leadNorm, contesto, agendo, vendio }] }
//   { kind: 'none' }
export async function parseSetteoWithAi(text, { now = new Date(), tz = TZ() } = {}) {
  if (!ENABLED()) return { kind: 'none' };
  if (!process.env.ANTHROPIC_API_KEY) return { kind: 'none' };
  if (!String(text || '').trim()) return { kind: 'none' };

  const hoy = localDateISO(now, tz);

  try {
    const res = await client().messages.create(
      {
        model: MODEL(),
        max_tokens: 500,
        messages: [{ role: 'user', content: PROMPT(text, hoy) }],
      },
      { timeout: TIMEOUT_MS() }
    );

    const raw = res.content?.find((b) => b.type === 'text')?.text || '';
    const json = raw.match(/\{[\s\S]*\}/);
    if (!json) return { kind: 'none' };
    const out = JSON.parse(json[0]);

    const leads = Array.isArray(out.leads) ? out.leads : [];
    const items = [];
    const vistos = new Set();

    for (const l of leads) {
      const leadName = String(l?.nombre || '').trim().slice(0, 80);
      const leadNorm = normalizeLeadName(leadName);
      // Un "nombre" de una letra o vacío es ruido del modelo, no un lead.
      if (!leadNorm || leadNorm.length < 2) continue;
      if (vistos.has(leadNorm)) continue;
      vistos.add(leadNorm);
      const agendo = l?.agendo ? 1 : 0;
      const vendio = l?.vendio ? 1 : 0;
      items.push({
        leadName,
        leadNorm,
        // La coherencia del embudo se vuelve a imponer acá y no se confía en el modelo:
        // el SQL la garantiza igual, pero así lo que se le confirma al closer ya es coherente.
        contesto: l?.contesto || agendo || vendio ? 1 : 0,
        agendo,
        vendio,
      });
    }

    if (!items.length) return { kind: 'none' };

    // La fecha del modelo se ACOTA: solo se acepta si es un día real y no es futura. Un
    // modelo que alucina "2027-01-01" no puede mandarle el setteo del closer a otro año.
    let fecha = hoy;
    const f = String(out.fecha || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(f) && f <= hoy && f >= shiftDateISO(hoy, -60)) fecha = f;

    return { kind: 'setteos', fecha, items };
  } catch (e) {
    console.warn('[Setteo] fallback IA falló:', e.message);
    return { kind: 'none' };
  }
}
