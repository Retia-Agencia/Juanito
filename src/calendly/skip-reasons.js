// src/calendly/skip-reasons.js
// Clasificación ESTABLE de por qué un push no se entregó. Fuente única compartida por el
// scheduler (que la escribe), la auditoría de skips (que alerta) y el dashboard (que la
// muestra). Sin deps nativas a propósito: el dashboard corre en otro contenedor.
//
// Por qué existe: la razón vivía SOLO como texto libre al final de `message`, así que todo
// consumidor terminaba haciendo `LIKE '%sin opt-in%'` y se rompía al cambiar una palabra del
// copy. El texto humano sigue yendo al `message`; el slug es lo que se consulta.

export const SKIP_SLUGS = {
  // ─── Comportamiento correcto: el push no debía salir ───────────────────────
  CANCELADA: 'cancelada',     // la cita se canceló en Calendly
  REAGENDADA: 'reagendada',   // cambió de hora; el poll agenda la nueva
  RESCHEDULED: 'rescheduled', // reagenda detectada en HubSpot (histórico: ya se escribía así)
  SUPERSEDED: 'superseded',   // fila duplicada que perdió contra la real (HubSpot vs Calendly)

  // ─── Pushes REALMENTE perdidos: un lead se quedó sin su precall ────────────
  SIN_OPTIN: 'sin-optin',     // el closer nunca le escribió a Juanito
  SIN_HILO: 'sin-hilo',       // hay opt-in pero sin contact_jid (sembrado/grandfathered)
  OBSOLETO: 'obsoleto',       // venció sin entregarse y la call ya empezó
  INESPERADO: 'inesperado',   // resultado no contemplado en el bucle de entrega
};

// Los que ameritan avisarle al admin. El resto es operación normal y alertar por ellos
// volvería la alerta ruido — que es la forma más rápida de que la ignoren.
//
// Ojo con `obsoleto`: desde que los pushes recuperables se reintentan en vez de quemarse,
// un closer sin opt-in ya NO deja filas 'sin-optin' en push 0/3 — reintenta hasta que la
// llamada arranca y muere como 'obsoleto'. O sea que este slug pasó a ser la huella
// principal del caso Daniela, no un detalle de infraestructura.
export const SKIP_ALERTABLES = new Set([
  SKIP_SLUGS.SIN_OPTIN,
  SKIP_SLUGS.SIN_HILO,
  SKIP_SLUGS.OBSOLETO,
  SKIP_SLUGS.INESPERADO,
]);

export const esAlertable = (slug) => SKIP_ALERTABLES.has(String(slug || ''));

// Etiqueta legible para el dashboard y el texto de la alerta.
export const ETIQUETA_SKIP = {
  [SKIP_SLUGS.CANCELADA]: 'cita cancelada',
  [SKIP_SLUGS.REAGENDADA]: 'reagendada',
  [SKIP_SLUGS.RESCHEDULED]: 'reagendada en HubSpot',
  [SKIP_SLUGS.SUPERSEDED]: 'duplicado descartado',
  [SKIP_SLUGS.SIN_OPTIN]: 'el closer no ha escrito a Juanito (sin opt-in)',
  [SKIP_SLUGS.SIN_HILO]: 'opt-in sin hilo (contact_jid)',
  [SKIP_SLUGS.OBSOLETO]: 'venció sin entregarse (la llamada ya había empezado)',
  [SKIP_SLUGS.INESPERADO]: 'resultado inesperado en la entrega',
};
