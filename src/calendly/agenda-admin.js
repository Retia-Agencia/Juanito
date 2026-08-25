// src/calendly/agenda-admin.js
// PURO. Conteo y formato de la agenda diaria que recibe la ADMIN de una marca (hoy: Mariana,
// EstadoX / IA para Abogados, 7am). Sin red, sin DB → se puede iterar en Windows.
//
// Es distinto del digest Push 1/2, que va al CLOSER con la lista de SUS calls (nombres,
// teléfonos, horas). Este va a quien supervisa: solo cuántas tiene cada uno. Por eso no lleva
// PII — ni nombres de leads ni teléfonos.

// Cuenta las calls de cada closer del roster.
//
// `calls`   = [{ closerEmail }] — una entrada por call del día, de CUALQUIER fuente.
// `roster`  = [{ email, name }] — TODOS los closers de la conexión.
//
// El roster se pasa entero a propósito: un closer sin calls sale con 0 en vez de desaparecer
// del mensaje. Un cero es información (hoy no tiene agenda) mientras que una ausencia es
// ambigua — se lee igual que "este closer ya no existe" o "el mensaje se cortó". Es el mismo
// razonamiento por el que el digest no manda conteos incompletos.
//
// Una call cuyo closer NO está en el roster se cuenta igual, al final y con el email como
// rótulo, en vez de descartarse en silencio: es la señal de que hay un host sin mapear, y
// perderla es exactamente cómo el programa estuvo un mes sin pushes sin que nadie se enterara.
// Devuelve [{ email, name, count, unmapped? }] — roster primero (por count desc, luego nombre),
// los sin mapear al final.
export function tallyByCloser(calls, roster) {
  const norm = (e) => String(e || '').toLowerCase().trim();
  const counts = new Map();
  for (const { email, name } of roster || []) {
    counts.set(norm(email), { email: norm(email), name, count: 0 });
  }
  const extras = new Map();
  for (const call of calls || []) {
    const email = norm(call?.closerEmail);
    if (!email) continue;
    if (counts.has(email)) {
      counts.get(email).count += 1;
    } else {
      if (!extras.has(email)) extras.set(email, { email, name: email, count: 0, unmapped: true });
      extras.get(email).count += 1;
    }
  }
  const enRoster = [...counts.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es')
  );
  const fuera = [...extras.values()].sort(
    (a, b) => b.count - a.count || a.email.localeCompare(b.email, 'es')
  );
  return [...enRoster, ...fuera];
}

// Arma el mensaje. `tally` sale de tallyByCloser; `dateLabel` ya viene formateado por el caller
// (que es quien conoce la TZ). `programLabel` rotula de qué programa se habla — la admin de una
// marca puede llegar a supervisar más de uno.
export function buildAgendaMessage({ tally, dateLabel, programLabel }) {
  const filas = tally || [];
  const total = filas.reduce((n, c) => n + c.count, 0);
  const lines = [`📞 Llamadas de hoy — ${programLabel}`, `🗓️ ${dateLabel}`, ''];

  if (!filas.length) {
    // Ningún closer configurado. No debería pasar (el job se autodesactiva sin roster), pero
    // un mensaje mudo sería peor que uno que dice qué está mal.
    lines.push('⚠️ No hay closers configurados para este programa.');
    return lines.join('\n');
  }

  for (const c of filas) {
    const marca = c.unmapped ? ' ⚠️ (sin mapear)' : '';
    lines.push(`• ${c.name}: ${c.count}${marca}`);
  }

  lines.push('', total === 0 ? 'Total: 0 — no hay llamadas agendadas para hoy.' : `Total: ${total}`);

  if (filas.some((c) => c.unmapped)) {
    lines.push('', '⚠️ Hay llamadas de un host que no está en el roster; avisá al equipo técnico.');
  }
  return lines.join('\n');
}
