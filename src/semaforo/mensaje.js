const EMOJI = {
  exito: '🟢',
  alerta: '🟡',
  peligro: '🔴',
  sin_dato: '⚪',
};

const MOTIVO = {
  sin_cohorte: 'No hay cohorte activa',
  sin_umbral: 'Falta cargar la meta en el CRM',
  sin_pauta: 'No hay gasto de pauta hoy',
  sin_referencia: 'Sin referencia para comparar',
};

const ETIQUETA = {
  costo_por_agenda: 'Costo por agenda',
};

function numero(valor) {
  return Number(valor).toLocaleString('es-CO');
}

function dinero(valor) {
  return valor == null ? 'sin dato' : `$${numero(valor)} COP`;
}

function cantidadAgendas(valor) {
  return `${numero(valor)} ${Number(valor) === 1 ? 'agenda' : 'agendas'}`;
}

function horaBogota(fecha) {
  const date = new Date(fecha);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Bogota',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function lineasMetrica(metrica, tipo) {
  const lineas = [
    `${EMOJI[metrica.color]} ${ETIQUETA[metrica.metrica] || metrica.metrica}: ${dinero(metrica.costo)}`,
  ];

  if (metrica.umbral) {
    lineas.push(
      `Meta ${dinero(metrica.umbral.meta)} · aceptable ${dinero(metrica.umbral.aceptable)}`
    );
  }
  lineas.push(`Gasto ${dinero(metrica.gasto)} · ${cantidadAgendas(metrica.agendas)}`);

  if (metrica.ayerALaMismaHora) {
    lineas.push(
      `Ayer a esta hora: ${dinero(metrica.ayerALaMismaHora.costo)} (${cantidadAgendas(metrica.ayerALaMismaHora.agendas)})`
    );
  }
  if (metrica.diasSeguidosEnRojo > 0) {
    const dias = Number(metrica.diasSeguidosEnRojo);
    lineas.push(`🔴 ${numero(dias)} ${dias === 1 ? 'día seguido' : 'días seguidos'} en rojo`);
  }
  if (metrica.motivo) lineas.push(MOTIVO[metrica.motivo]);
  for (const nota of metrica.notas || []) {
    lineas.push(`• ${nota.tipo === 'problema' ? '⚠️ ' : ''}${nota.texto}`);
  }
  if (tipo === 'cierre' && metrica.trayectoria?.length) {
    const puntos = metrica.trayectoria.map(
      (p) => `${p.hora} ${dinero(p.gasto)} · ${numero(p.agendas)} ag`
    );
    lineas.push(`Trayectoria: ${puntos.join(' | ')}`);
  }
  return lineas;
}

// El CRM ya decide qué corresponde enviar; aquí solo se vuelve legible, sin DB ni red.
export function armarMensaje(envio, sincronizacion) {
  const titulo = envio.tipo === 'cierre' ? 'Cierre del día' : 'Semáforo de pauta';
  const lineas = [`🚦 ${titulo} · ${envio.programa} · ${envio.hora}`];

  if (envio.error) lineas.push(`⚠️ ${envio.error}`);
  else {
    for (const metrica of envio.metricas || []) lineas.push(...lineasMetrica(metrica, envio.tipo));
  }

  if (sincronizacion?.estado === 'error') {
    const hora = sincronizacion.ultimaFoto ? horaBogota(sincronizacion.ultimaFoto) : null;
    lineas.push(`⚠️ No se pudo leer Meta; cifras de la última foto${hora ? ` (${hora})` : ''}`);
  }
  lineas.push(`Ver en el Hub: ${envio.enlaceHub}`);
  return lineas.join('\n');
}
