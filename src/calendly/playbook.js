// src/calendly/playbook.js
// PURO (sin DB ni red → testeable en Windows). El "Playbook · confirmación de agendas" de 30X
// (WBR 28-sep → 4-oct, diapositiva 11) aplicado a los pushes precall (§18.CR).
//
// El playbook le pide al closer 4 toques por agenda y un corte:
//   1. Al agendar   → bienvenida, pide confirmar asistencia, material del programa, confirma
//                     fecha, hora y país (zona horaria).
//   2. −48 h        → recordatorio, "respóndeme SÍ para dejar tu espacio" y una pregunta de
//                     diagnóstico ("¿qué quieres resolver con el programa?").
//   3. −24 h (corte)→ si confirmó, refuerzo corto con la hora. Si no, lo llama una vez y le deja
//                     "como no tuve tu confirmación, voy a liberar el espacio". Sin confirmación
//                     la reunión se cancela (HubSpot: Cancelada + próximo contacto con fecha).
//   4. −1 h         → el link de la reunión y "te espero a las __".
//   Si no se conecta → a los 10 minutos lo llama y le escribe; si responde, reagenda ahí mismo.
//
// En Juanito eso queda así, para las conexiones de CALENDLY_PLAYBOOK:
//   1 = Push 0 al agendar (permanente, sin la fecha de vencimiento de la prueba §18.CK)
//   2 = digest de 2 días antes (Push 48h)
//   3 = la víspera ya no manda un digest de links: le pregunta al closer quién confirmó y,
//       con su respuesta, le arma el refuerzo o el "voy a liberar el espacio" de cada lead
//   4 = Push 3 a 1 hora en vez de 25 minutos, con copy nuevo
//   +10 = Push 7, uno por cita, 10 minutos después de la hora de inicio
// El Push 2 (6:30am del día de la llamada) no está en el playbook y se apaga para esas
// conexiones, y una cita que el closer marcó sin confirmar o cancelada en el corte no recibe
// ni el Push 3 ni el Push 7.
//
// Juanito NUNCA escribe en HubSpot (decisión 2026-07-20): el registro del playbook lo hace el
// closer, y lo que hace Juanito es recordárselo en el momento justo.

import { PROGRAMS } from './programs.js';

// Conexiones con el playbook prendido. Vacío = apagado: todo se comporta como antes.
export const PLAYBOOK_CONEXIONES = () =>
  new Set((process.env.CALENDLY_PLAYBOOK || '').split(',').map((s) => s.trim()).filter(Boolean));

export const playbookActivoPara = (conexion) => Boolean(conexion) && PLAYBOOK_CONEXIONES().has(conexion);

// Por programa: la conexión que lo hostea decide. Lo usan los builders de copy, que reciben el
// programa y no al closer.
export const programaEnPlaybook = (programKey) => playbookActivoPara(PROGRAMS[programKey]?.connection);

// Toque 4: el Push 3 sale una hora antes (el resto de las conexiones sigue con LEAD_MIN).
export const PLAYBOOK_LEAD_MIN = () => Number(process.env.CALENDLY_PLAYBOOK_LEAD_MIN || 60);
// "Si no se conecta": cuántos minutos después de la hora de inicio sale el Push 7.
export const PLAYBOOK_NO_CONECTA_MIN = () => Number(process.env.CALENDLY_PLAYBOOK_NO_CONECTA_MIN || 10);
// Pasado este margen después del inicio, un Push 7 atrasado (pausa, WhatsApp caído) ya no sirve:
// la llamada ya terminó o ya se resolvió.
export const PLAYBOOK_NO_CONECTA_VIGENCIA_MIN = 30;
// Toque 2: una cita agendada hace menos de esto ya recibió el toque 1 —que también pide
// confirmación— y no necesita otro mensaje pidiendo lo mismo unas horas después.
export const PLAYBOOK_48H_RECIENTE_HORAS = 12;

// Estados del corte que apagan los pushes de después (−1 h y +10 min).
export const ESTADOS_SIN_LLAMADA = new Set(['no_confirmada', 'cancelada']);
export const frenaPorCorte = (estado) => ESTADOS_SIN_LLAMADA.has(String(estado || ''));

export const due7Utc = (startIso, min = PLAYBOOK_NO_CONECTA_MIN()) => new Date(new Date(startIso).getTime() + min * 60000);
