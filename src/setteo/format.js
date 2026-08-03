// src/setteo/format.js
// PURO (solo lee env; sin red, DB ni WhatsApp → testeable en Windows). El scope del piloto y
// los textos que ve el closer. Vive aparte de capture.js a propósito: ese módulo importa la
// DB y HubSpot, así que todo lo que se meta ahí deja de poder testearse fuera de Docker.

// Scope del piloto. Cae al scope del reporte de setteo y, en última instancia, al del nudge —
// el mismo escalón que usa scheduler/setteo.js. Sin scope configurado NO se captura nada:
// el default seguro es "nadie", no "todos" (nada de fan-out sorpresa a la vertical entera).
function scopeEmails() {
  const raw =
    process.env.SETTEO_CAPTURE_CLOSERS ||
    process.env.SETTEO_REPORT_CLOSERS ||
    process.env.CALENDLY_PUSH4_CLOSERS ||
    '';
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function isCloserInScope(email) {
  if (!email) return false;
  return scopeEmails().includes(String(email).toLowerCase().trim());
}

// Confirmación de lo que quedó guardado. Corta: es WhatsApp, no un reporte.
// Regla: nunca afirmar más de lo que se guardó. Si algo no se pudo cruzar, se dice.
export function buildConfirmacion({ fecha, items, resultado, hoy }) {
  const n = resultado.guardados;
  const agendaron = items.filter((i) => i.agendo).length;
  const vendieron = items.filter((i) => i.vendio).length;
  const contestaron = items.filter((i) => i.contesto).length;

  const cuando = fecha === hoy ? '' : ` del ${fecha}`;
  const lineas = [`✅ Anotado${cuando}: *${n}* ${n === 1 ? 'setteo' : 'setteos'}.`];

  const detalle = [];
  if (contestaron) detalle.push(`${contestaron} ${contestaron === 1 ? 'contestó' : 'contestaron'}`);
  if (agendaron) detalle.push(`${agendaron} ${agendaron === 1 ? 'agendó' : 'agendaron'}`);
  if (vendieron) detalle.push(`${vendieron} ${vendieron === 1 ? 'venta' : 'ventas'}`);
  if (detalle.length) lineas.push(`   ${detalle.join(' · ')}`);

  // Un lead con cita ya lo mide el Push 4: contarlo dos veces inflaría su propio número.
  if (resultado.calls) {
    lineas.push(
      resultado.calls === 1
        ? '\nℹ️ 1 de esos ya tiene cita agendada, así que lo cuento como call, no como setteo.'
        : `\nℹ️ ${resultado.calls} de esos ya tienen cita agendada, así que los cuento como calls, no como setteos.`
    );
  }
  if (resultado.ambiguos) {
    lineas.push(`⚠️ ${resultado.ambiguos} con homónimos en HubSpot — no supe cuál era, quedó sin cruzar.`);
  }
  if (resultado.sinMatch) {
    lineas.push(`⚠️ ${resultado.sinMatch} que no encontré en HubSpot. Si ya lo registraste allá, revisá el nombre.`);
  }
  lineas.push('\n_Escribí *`/missetteos`* para ver cómo vas._');
  return lineas.join('\n');
}

// Cuando el closer dice CUÁNTOS pero no QUIÉNES. No se inventan filas para cuadrar el número:
// la tabla es una fila por lead y el cruce con HubSpot necesita el nombre.
export function buildPedirNombres(conteo) {
  return (
    `Anoté que fueron *${conteo}*, pero necesito los *nombres* para cruzarlos con HubSpot y que te cuenten.\n\n` +
    'Pasámelos así: _"toqué a Juan Pérez, María Gómez y Pedro Ruiz; María agendó"_.'
  );
}

// ─── /missetteos: las tres cifras ─────────────────────────────────────────────
// Reportado · registrado en HubSpot · cuota por horas libres. Cada una responde una pregunta
// distinta y por eso van juntas:
//   reportado  → qué hiciste (lo que me contaste)
//   HubSpot    → qué quedó registrado, que es de lo que dependen las comisiones
//   cuota      → qué te tocaba según tus horas libres (15/hora, Protocolo Máquina de Ventas)
//
// La BRECHA entre las dos primeras es el dato que hoy no existe en ningún lado. Se muestra como
// pregunta, no como veredicto: puede ser que no registró, o que no lo hizo. Juanito no puede
// saber cuál (nunca escribe en HubSpot), así que no lo afirma.
const pad = (n, w) => String(n).padStart(w);

export function formatMisSetteos({ closerName, dateLabel, reportado, hubspot, cuota, hoyLabel = 'del día' }) {
  const L = [`🧲 *Mis setteos* — ${dateLabel}`, ''];

  const w = Math.max(String(reportado.total).length, String(hubspot ?? '—').length, String(cuota.cuota).length);
  L.push('```');
  L.push(`Reportados a mí         ${pad(reportado.total, w)}`);
  if (hubspot === null || hubspot === undefined) {
    L.push(`Registrados en HubSpot  ${pad('—', w)}  (no pude consultarlo)`);
  } else {
    const brecha = reportado.total - hubspot;
    L.push(`Registrados en HubSpot  ${pad(hubspot, w)}${brecha > 0 ? `  faltan ${brecha}` : ''}`);
  }
  L.push(`Cuota ${hoyLabel.padEnd(17)} ${pad(cuota.cuota, w)}  (${cuota.horasLibres}h libres × 15)`);
  L.push('```');

  if (reportado.total) {
    const partes = [`${reportado.contestaron} ${reportado.contestaron === 1 ? 'contestó' : 'contestaron'}`];
    if (reportado.agendaron) partes.push(`${reportado.agendaron} ${reportado.agendaron === 1 ? 'agendó' : 'agendaron'}`);
    if (reportado.vendieron) partes.push(`${reportado.vendieron} ${reportado.vendieron === 1 ? 'venta' : 'ventas'}`);
    L.push(`De los ${reportado.total}: ${partes.join(' · ')}`);
    // La tasa que mide al setter: agendados sobre los que CONTESTARON. Sobre el total premia
    // a quien tiene la lista más caliente. Con muestras chicas no se muestra: un 1 de 1 daría
    // "100%" y eso es ruido presentado como dato.
    if (reportado.contestaron >= 5 && reportado.tasaSetteo !== null) {
      L.push(`_De los que contestaron, agendás el ${Math.round(reportado.tasaSetteo * 100)}%._`);
    }
  }

  if (reportado.eranCall) {
    L.push(
      `\nℹ️ ${reportado.eranCall} ${reportado.eranCall === 1 ? 'lead ya tenía' : 'leads ya tenían'} cita agendada — ` +
        `${reportado.eranCall === 1 ? 'cuenta' : 'cuentan'} como call, no como setteo.`
    );
  }
  if (reportado.ambiguos) {
    L.push(`⚠️ ${reportado.ambiguos} con homónimos en HubSpot, sin cruzar.`);
  }

  if (hubspot !== null && hubspot !== undefined && reportado.total - hubspot > 0) {
    const brecha = reportado.total - hubspot;
    L.push(
      `\n⚠️ *${brecha} ${brecha === 1 ? 'setteo que me contaste no está' : 'setteos que me contaste no están'} ` +
        `en HubSpot.* Sin registro no ${brecha === 1 ? 'cuenta' : 'cuentan'} para comisión.`
    );
  }
  if (cuota.callsFuera) {
    L.push(`_(${cuota.callsFuera} ${cuota.callsFuera === 1 ? 'call cayó' : 'calls cayeron'} fuera de la jornada: no te bajan la cuota.)_`);
  }

  return L.join('\n');
}

// Cuando el closer todavía no reportó nada en la ventana.
export function formatMisSetteosVacio({ dateLabel, cuota }) {
  return (
    `🧲 *Mis setteos* — ${dateLabel}\n\n` +
    `Todavía no me contaste ningún setteo.\n` +
    `Tu cuota de hoy son *${cuota.cuota}* (${cuota.horasLibres}h libres × 15).\n\n` +
    `Contámelo como quieras: _"toqué a Juan Pérez y María Gómez, María agendó"_.`
  );
}
