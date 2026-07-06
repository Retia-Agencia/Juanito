// src/setting/templates.js
// Mapeo de (programa, toque) → plantilla aprobada de la Cloud API (Twilio Content SID)
// + variables. Las plantillas se aprueban en Meta/Twilio (categoría marketing: es
// re-enganche a agendar) y su SID se pasa por env, así se cambia el copy sin redeploy.
//
// La primera variable {{1}} es el nombre del lead (personalización dentro de lo que
// permite una plantilla aprobada — el cuerpo es fijo y bendecido por Meta). Si el SID
// de un toque no está configurado, resolveTemplate devuelve null → el scheduler SALTA
// ese toque (no inventa texto libre: fuera de la ventana de 24h solo valen plantillas).

import { firstNameOf } from './setting-logic.js';

// programa → toque → env var con el Content SID de la plantilla aprobada.
const TEMPLATE_ENV = {
  abogados: {
    1: 'SETTING_TEMPLATE_ABOGADOS_TOUCH1',
    2: 'SETTING_TEMPLATE_ABOGADOS_TOUCH2',
  },
  // Fase 2 (30X): se agregan aquí las claves por programa a medida que se aprueban.
};

// Devuelve { contentSid, vars, preview } o null si no hay plantilla configurada.
export function resolveTemplate({ program, touch_n, to_name, env = process.env }) {
  const envKey = TEMPLATE_ENV[program]?.[touch_n];
  if (!envKey) return null;
  const contentSid = (env[envKey] || '').trim();
  if (!contentSid) return null;
  const nombre = firstNameOf(to_name) || 'hola';
  return {
    contentSid,
    vars: { 1: nombre },
    // Texto legible para logs/auditoría (NO es lo que ve el lead — eso lo define la
    // plantilla aprobada en Twilio; aquí solo dejamos rastro de qué se disparó).
    preview: `[plantilla ${program}/toque${touch_n}] {1}="${nombre}"`,
  };
}
