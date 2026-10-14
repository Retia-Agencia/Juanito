// src/calendly/confirmacion-logic.js
// PURO (sin DB ni WA → testeable en Windows). Confirmación de las llamadas del día en el Push 2.
//
// Por qué existe (2026-10-13, pedido de Alejandro para el Dashboard de Closers): las citas del
// dashboard pasan a salir de HubSpot, y HubSpot no se entera de que una cita se canceló (del 28-sep
// al 4-oct, 48 de 92 canceladas en Calendly seguían en HubSpot como cita normal). El closer sí lo
// sabe: el lead le responde el Push 1. Así que, justo después del Push 2, Juanito le pregunta
// quiénes le confirmaron, y lo que diga va al dashboard como `juanito_confirmaciones`.
//
// La respuesta es libre y corta: "1 3", "todos", "todos menos el 2", "2 canceló, 1 y 3 sí".
// Los números son los de la lista de la pregunta, en el mismo orden (por hora).

import { formatCallTime } from './index.js';

export const ESTADOS_CONFIRMACION = ['confirmada', 'no_confirmada', 'cancelada'];

export const CONFIRMACION_LABELS = {
  confirmada: '✅ confirmó',
  no_confirmada: '⏳ sin confirmar',
  cancelada: '❌ canceló',
};

const sinTildes = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

// items: [{ name, startIso }] ya en el orden en que se numeran.
export function buildConfirmacionPregunta({ items, tz }) {
  const lineas = items.map((it, i) => `${i + 1}. ${formatCallTime(it.startIso, tz)} — ${it.name || 'el prospecto'}`);
  return (
    `✅ *¿Quiénes te confirmaron hoy?*\n` +
    `${lineas.join('\n')}\n\n` +
    `Respóndeme con los números de los que confirmaron (ej: *1 3*). Si alguno canceló, dímelo: *2 canceló*. ` +
    `Si confirmaron todos: *todos*.`
  );
}

// Orden de las listas: el mismo del digest (por hora). Se exporta para que el scheduler numere
// la pregunta y guarde las posiciones con la MISMA función.
export const ordenarPorHora = (items) => [...items].sort((a, b) => new Date(a.startIso) - new Date(b.startIso));

const esCancelacion = (t) => /^cancel/.test(t);
const esConfirmacion = (t) => /^(confirm|si|sii+|ok|listo|lista|van|va|asiste|asisten|viene|vienen)$/.test(t) || /^confirm/.test(t);
const esNegativaSiguiente = (t) =>
  !t || /^\d+$/.test(t) || /^(y|e|ni|ha|han|he|hay|confirm|contest|respond|responde|dice|dijo|aun|todavia|nada|el|la|los|las)/.test(t);
const TODOS = new Set(['todos', 'todas', 'todo']);
const NINGUNO = new Set(['ninguno', 'ninguna', 'nadie']);
const MENOS = new Set(['menos', 'excepto', 'salvo', 'sino']);
const CUANTIFICADO = /^(las|los|mis|tus|sus|de|del|estas|estos|esas|esos|el|la|lo)$/;
const PENDIENTE = /^(pendiente|pendientes|esperando)$/;

// Devuelve { kind: 'ok', todos, explicitos } o { kind: 'unknown' }.
//   todos:      null | 'confirmada' | 'no_confirmada' — "todos" / "ninguno"
//   explicitos: { [posición 1..n]: estado } — lo que el closer dijo de cada número
// `n` = cuántas llamadas tenía la lista; un número fuera de rango se ignora.
export function parseConfirmacion(text, n) {
  const norm = sinTildes(text).replace(/✅|👍|✔️?/g, ' si ').replace(/❌|✖️?/g, ' no ');
  const tokens = norm.match(/\d+|[a-zñ]+/g) || [];
  const explicitos = {};
  let todos = null;
  let pendientes = [];
  let menos = false;
  let ultimo = null;
  let hubo = false; // algún número en rango o un "todos"/"ninguno"

  // "todos" y "ninguno" en el mismo mensaje con sentidos opuestos: se repregunta en vez de
  // quedarse con el último, que fue justo el error que marcó 9 llamadas al revés.
  const fijarTodos = (estado) => {
    if (todos && todos !== estado) return false;
    todos = estado;
    return true;
  };
  const asignar = (estado) => {
    for (const p of pendientes) explicitos[p] = estado;
    pendientes = [];
    ultimo = estado;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^\d+$/.test(t)) {
      const p = Number(t);
      if (p >= 1 && p <= n) {
        pendientes.push(p);
        hubo = true;
      }
      continue;
    }
    if (TODOS.has(t)) {
      // "todas LAS llamadas", "todos MIS leads": cuantificador de otra frase, no la respuesta.
      // Caso real (14-oct): "Ninguno, mándame el primer push de todas las llamadas de hoy" quedó
      // como 9 confirmadas porque este "todas" pisaba al "Ninguno".
      if (CUANTIFICADO.test(tokens[i + 1] || '')) continue;
      if (!fijarTodos(tokens[i - 1] === 'no' ? 'no_confirmada' : 'confirmada')) return { kind: 'unknown' };
      hubo = true;
      continue;
    }
    if (NINGUNO.has(t)) {
      if (!fijarTodos('no_confirmada')) return { kind: 'unknown' };
      hubo = true;
      continue;
    }
    if (MENOS.has(t)) {
      if (pendientes.length) asignar(ultimo || 'confirmada');
      menos = true;
      continue;
    }
    if (esCancelacion(t)) {
      asignar('cancelada');
      continue;
    }
    if (t === 'no') {
      // "2 no", "el 3 no ha confirmado", "no contestó" → sin confirmar. "no confirmó" se come la
      // palabra siguiente para que "confirmó" no lo vuelva confirmado.
      const sig = tokens[i + 1];
      // "el 2 no va", "no puede": no viene → cancelada (sin esto, "va" lo volvía confirmada).
      if (sig && /^(va|van|viene|vienen|puede|pueden|podra|asiste|asisten|llega)$/.test(sig)) {
        i++;
        asignar('cancelada');
      } else if (esNegativaSiguiente(sig)) {
        if (sig && /^(confirm|contest|respond|responde)/.test(sig)) i++;
        asignar('no_confirmada');
      }
      continue;
    }
    if (PENDIENTE.test(t)) {
      asignar('no_confirmada');
      continue;
    }
    if (esConfirmacion(t)) {
      asignar('confirmada');
      continue;
    }
  }
  // Números sin palabra después: "1 3" son confirmadas; después de "menos", las que no.
  if (pendientes.length) asignar(menos ? 'no_confirmada' : ultimo || 'confirmada');

  if (!hubo) return { kind: 'unknown' };
  return { kind: 'ok', todos, explicitos };
}

// Estado final de cada posición. En la PRIMERA respuesta lo que el closer no nombró queda sin
// confirmar ("1 3" → la 2 no confirmó). En una corrección posterior ("el 2 canceló") solo cambia
// lo que nombra. Devuelve { [pos]: estado } solo con las posiciones que cambian.
export function resolverConfirmacion(parsed, n, { primera }) {
  const out = {};
  if (parsed.todos) for (let p = 1; p <= n; p++) out[p] = parsed.todos;
  else if (primera) for (let p = 1; p <= n; p++) out[p] = 'no_confirmada';
  Object.assign(out, parsed.explicitos);
  return out;
}

// Una corrección tardía tiene que ser inequívoca: número + palabra de estado. Sin esto, cualquier
// mensaje con un número ("hoy setee 3") tocaría las confirmaciones el resto del día.
export function esCorreccionClara(parsed) {
  return parsed.kind === 'ok' && !parsed.todos && Object.keys(parsed.explicitos).length > 0;
}

export function buildConfirmacionResumen({ items, estados }) {
  const lineas = items.map((it, i) => `${i + 1}. ${it.name || 'el prospecto'}: ${CONFIRMACION_LABELS[estados[i + 1]] || CONFIRMACION_LABELS.no_confirmada}`);
  return `📝 Anotado:\n${lineas.join('\n')}\n\nSi algo cambia (por ejemplo, alguien cancela), escríbeme *2 canceló*.`;
}

export const CONFIRMACION_REPROMPT =
  '🙈 No te entendí. Respóndeme con los números de los que confirmaron (ej: *1 3*), *todos*, o *2 canceló*.';
