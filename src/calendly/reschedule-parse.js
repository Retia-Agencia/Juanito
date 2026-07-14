// src/calendly/reschedule-parse.js
// PURO (sin red, sin DB → testeable en Windows). Interpreta la fecha/hora que el closer
// escribe cuando dice que reagendó (§18.AC): "hoy 3pm", "mañana 10:30am", "viernes 2pm",
// "22/07 9am". Mismo espíritu que parseAsistenciaReply: determinista y sin IA.
//
// Si esto devuelve 'none', outcome-capture intenta UNA vez con Claude (reschedule-ai.js)
// antes de repreguntarle al closer. El regex se lleva el 90% de los casos sin costo.

// Meridiano por defecto cuando el closer no lo dice ("a las 3"): las calls son de horario
// laboral, así que 1-6 → pm y 7-11 → am. La confirmación SIEMPRE hace echo de la fecha
// resuelta, así que un error acá se ve y se corrige en el mismo hilo.
const AM_HOURS = [7, 8, 9, 10, 11];

const WEEKDAYS = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
};

const MONTHS = {
  enero: 1, ene: 1,
  febrero: 2, feb: 2,
  marzo: 3, mar: 3,
  abril: 4, abr: 4,
  mayo: 5, may: 5,
  junio: 6, jun: 6,
  julio: 7, jul: 7,
  agosto: 8, ago: 8,
  septiembre: 9, setiembre: 9, sep: 9, sept: 9,
  octubre: 10, oct: 10,
  noviembre: 11, nov: 11,
  diciembre: 12, dic: 12,
};

// "Aún no sabemos" y variantes → el closer reagendó pero no tiene fecha todavía.
const UNKNOWN_RE =
  /\b(aun no|aun sin|todavia no|no se sabe|no se aun|no lo se|no se todavia|no sabemos|no sabe|no hay fecha|sin fecha|sin definir|por definir|no definimos|no quedamos|queda pendiente|esta pendiente|pendiente de|no me dijo|no me ha dicho|no se)\b/;

// Normaliza SIN matar los separadores de fecha/hora: conserva ":" "/" "-" (a diferencia
// del normalizeReply de calendly/index.js, que los borraría junto con la puntuación).
function norm(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s:/.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Aritmética de zona horaria (sin dependencias) ────────────────────────────

// Offset del TZ respecto a UTC, en ms, para ese instante.
function tzOffsetMs(ms, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
  );
  return asUtc - ms;
}

// Hora de pared (en tz) → instante UTC. Doble pasada por si hay cambio de horario
// (Bogotá no lo tiene, pero el default de TZ es configurable).
export function wallClockToUtc({ y, m, d, hh, mm }, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  const once = guess - tzOffsetMs(guess, tz);
  return new Date(guess - tzOffsetMs(once, tz));
}

// Fecha de pared "hoy" en tz.
function todayInTz(nowMs, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    })
      .formatToParts(new Date(nowMs))
      .map((p) => [p.type, p.value])
  );
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}

function addDays({ y, m, d }, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function dowOf({ y, m, d }) {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function nextMonth({ y, m }) {
  return m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
}

// ─── Extracción ───────────────────────────────────────────────────────────────

// Meridiano dicho con palabras ("de la mañana", "en la tarde"). Devuelve el hint y el
// texto SIN esa frase: si no, "de la mañana" se confundiría con el día "mañana".
function extractMeridiem(n) {
  let hint = null;
  let text = n;
  if (/\b(de la|en la|por la)\s+(manana|madrugada)\b/.test(text)) hint = 'am';
  if (/\b(de la|en la|por la)\s+(tarde|noche)\b/.test(text)) hint = 'pm';
  text = text.replace(/\b(de la|en la|por la)\s+(manana|madrugada|tarde|noche)\b/g, ' ');
  // OJO: en "10:30am" NO hay frontera de palabra entre el 0 y la a → un \bam\b no matchea.
  // El meridiano puede venir pegado al número, así que se acepta un dígito antes.
  if (!hint && /(?:^|\d|\s)a\s?m\b/.test(text)) hint = 'am';
  if (!hint && /(?:^|\d|\s)p\s?m\b/.test(text)) hint = 'pm';
  if (/\bmediodia\b/.test(text)) hint = 'pm';
  return { hint, text: text.replace(/\s+/g, ' ').trim() };
}

// Devuelve { hh, mm } o null. Acepta 10:30, 10.30, 3pm, "a las 3", "3 y media".
function extractTime(n, hint) {
  let hh = null;
  let mm = 0;

  // Sin \b de cierre: en "10:30am" el 0 y la a son ambos word chars → no hay frontera.
  // (?!\d) evita comerse "10:305".
  const hm = n.match(/\b(\d{1,2})[:h.](\d{2})(?!\d)/);
  const yMedia = n.match(/\b(\d{1,2})\s*y\s*(media|cuarto)\b/);
  // (?<![:\d]) para no leer el "30" de "10:30am" como la hora.
  const conMeridiano = n.match(/(?<![:\d])(\d{1,2})\s*[ap]\s?m\b/);
  const aLas = n.match(/\ba\s*las?\s*(\d{1,2})\b/);
  const mediodia = /\bmediodia\b/.test(n);

  if (hm) {
    hh = Number(hm[1]);
    mm = Number(hm[2]);
  } else if (yMedia) {
    hh = Number(yMedia[1]);
    mm = yMedia[2] === 'media' ? 30 : 15;
  } else if (conMeridiano) {
    hh = Number(conMeridiano[1]);
  } else if (aLas) {
    hh = Number(aLas[1]);
  } else if (mediodia) {
    hh = 12;
  } else {
    // Último recurso: un número suelto de 1-2 dígitos que no sea parte de una fecha
    // (ya consumida por extractDay) — "hoy 3", "el viernes 10".
    const solo = n.match(/(?:^|\s)(\d{1,2})(?:\s|$)/);
    if (solo) hh = Number(solo[1]);
  }

  if (hh === null || !Number.isFinite(hh)) return null;
  if (mm < 0 || mm > 59) return null;

  // Meridiano: explícito > hint de palabras > heurística de horario laboral.
  if (hh === 24) hh = 0;
  if (hh > 12 && hh <= 23) return { hh, mm }; // ya viene en 24h ("15:30")
  if (hh > 23) return null;

  const mer = hint || (AM_HOURS.includes(hh) ? 'am' : 'pm');
  if (mer === 'pm' && hh < 12) hh += 12;
  if (mer === 'am' && hh === 12) hh = 0;
  return { hh, mm };
}

// Devuelve { date, rest } — la fecha de pared y el texto sin el trozo consumido, para
// que extractTime no confunda el día ("22/07") con una hora.
function extractDay(n, today) {
  // dd/mm[/yyyy] o dd-mm[-yyyy]
  const dmy = n.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (dmy) {
    const d = Number(dmy[1]);
    const m = Number(dmy[2]);
    let y = dmy[3] ? Number(dmy[3]) : today.y;
    if (y < 100) y += 2000;
    if (d < 1 || d > 31 || m < 1 || m > 12) return null;
    return { date: { y, m, d }, rest: n.replace(dmy[0], ' ') };
  }

  // "22 de julio", "22 jul", "el 22 de julio"
  const dMes = n.match(/\b(\d{1,2})\s*(?:de\s+)?([a-z]{3,10})\b/);
  if (dMes && MONTHS[dMes[2]]) {
    const d = Number(dMes[1]);
    const m = MONTHS[dMes[2]];
    if (d < 1 || d > 31) return null;
    // Si ese día/mes ya pasó este año, es del año que viene.
    const y = m < today.m || (m === today.m && d < today.d) ? today.y + 1 : today.y;
    return { date: { y, m, d }, rest: n.replace(dMes[0], ' ') };
  }

  // "el 22 a las 9" — día del mes suelto. Exige el "el"/"día" delante para no confundir
  // la hora con un día. Si ese número ya pasó este mes, es del mes que viene.
  const soloDia = n.match(/\b(?:el|dia)\s+(\d{1,2})\b/);
  if (soloDia) {
    const d = Number(soloDia[1]);
    if (d >= 1 && d <= 31) {
      const base = d >= today.d ? { y: today.y, m: today.m } : nextMonth(today);
      return { date: { ...base, d }, rest: n.replace(soloDia[0], ' ') };
    }
  }

  if (/\bpasado\s*manana\b/.test(n))
    return { date: addDays(today, 2), rest: n.replace(/\bpasado\s*manana\b/, ' ') };
  if (/\bmanana\b/.test(n)) return { date: addDays(today, 1), rest: n.replace(/\bmanana\b/, ' ') };
  if (/\bhoy\b/.test(n)) return { date: today, rest: n.replace(/\bhoy\b/, ' ') };
  if (/\b(hoy mismo|mas tarde|esta tarde|esta noche)\b/.test(n))
    return { date: today, rest: n.replace(/\b(hoy mismo|mas tarde|esta tarde|esta noche)\b/, ' ') };

  // Nombre de día → próxima ocurrencia. Si es el mismo día de hoy, se entiende "el que
  // viene" (para hoy dirían "hoy"). "el próximo viernes" cae acá igual.
  for (const [nombre, dow] of Object.entries(WEEKDAYS)) {
    const re = new RegExp(`\\b${nombre}s?\\b`);
    if (re.test(n)) {
      const delta = (dow - dowOf(today) + 7) % 7 || 7;
      return { date: addDays(today, delta), rest: n.replace(re, ' ') };
    }
  }

  // Sin día explícito: "a las 3" = hoy. El guard de fecha pasada lo atrapa si ya pasó.
  return { date: today, rest: n, implied: true };
}

// ─── API ──────────────────────────────────────────────────────────────────────

// Devuelve:
//   { kind: 'datetime', startUtc: Date }
//   { kind: 'unknown_date' }                        → reagendó pero aún no hay fecha
//   { kind: 'invalid', reason: 'past'|'far' }       → entendí la fecha pero no sirve
//   { kind: 'none' }                                → no entendí (→ fallback IA → repregunta)
export function parseRescheduleReply(text, { nowMs = Date.now(), tz = 'America/Bogota' } = {}) {
  const n0 = norm(text);
  if (!n0) return { kind: 'none' };

  const { hint, text: n } = extractMeridiem(n0);
  const today = todayInTz(nowMs, tz);

  const day = extractDay(n, today);
  if (!day) return { kind: 'none' };

  const time = extractTime(day.rest, hint);
  if (!time) return UNKNOWN_RE.test(n0) ? { kind: 'unknown_date' } : { kind: 'none' };

  const startUtc = wallClockToUtc({ ...day.date, hh: time.hh, mm: time.mm }, tz);
  if (Number.isNaN(startUtc.getTime())) return { kind: 'none' };

  return validateReschedule(startUtc, nowMs);
}

// Guards compartidos con el fallback de IA: ni fechas pasadas ni delirios a 3 meses.
export function validateReschedule(startUtc, nowMs = Date.now()) {
  const deltaMin = (startUtc.getTime() - nowMs) / 60000;
  if (deltaMin < -15) return { kind: 'invalid', reason: 'past' };
  if (deltaMin > 90 * 24 * 60) return { kind: 'invalid', reason: 'far' };
  return { kind: 'datetime', startUtc };
}
