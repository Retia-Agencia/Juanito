// src/calendly/accounts.js
// Registro de cuentas de Calendly. FUENTE ÚNICA DE VERDAD de lo que distingue a una
// empresa de otra: su token, su organización, sus event_types, y qué features aplican.
//
// Por qué existe: Juanito nació atendiendo UNA cuenta (30X/EstadoX) y todo eso vivía como
// singleton en index.js (un TOKEN, un ORG_URI, una lista de ETs). Al sumar una agencia con
// su PROPIA cuenta de Calendly, ese tuple deja de ser único → se vuelve una tabla.
//
// Cómo se agrega una cuenta nueva:
//   1. Resolver org URI y event_types contra la cuenta real (los ETs tipo pool NO se
//      enumeran por API: se leen del `event_type` de reservas reales en /scheduled_events).
//   2. Agregar la entrada acá con su token por env.
//   3. Agregar sus closers en closers.js con `account: '<key>'`.
//   4. Agregar el copy de sus programas (PROGRAM_PITCH / MATERIAL_LINKS en index.js).
//      Sin copy, el push degrada a "mándalo manual" — nunca al pitch de otra empresa.
//
// AUTO-DESACTIVACIÓN: `activeAccounts()` filtra por token presente, igual que todos los
// jobs del scheduler (stripe-alerts, sheets-report). Una cuenta sin su token simplemente
// no existe y el sistema se comporta como si nunca se hubiera agregado.

// ─── event_types por programa ─────────────────────────────────────────────────
// Auditoría 2026-07-14/16: la lista de programas la dicta el jefe; estos son sus ETs.
//  - Postulación Implementación AI Second Brain 30X
//  - Postulación Programa IA para Abogados | EstadoX
//  - Postulación LinkedIn Sales 30X
//  - Postulación AI for Developers 30X               (agregado 2026-07-14)
//  - Postulación Operaciones Escalables con AI 30X   (agregado 2026-07-14)
//  - Postulación Instagram & TikTok for Business 30X (agregado 2026-07-16)
//
// Los event_types tipo pool NO se pueden enumerar por la API (el query de /event_types
// org-wide solo devuelve los `kind=solo`). Se resuelven mirando el `event_type` de las
// reservas reales en /scheduled_events — así se resolvió el de Instagram el 2026-07-16,
// cuando el programa ya tenía 11 llamadas agendadas. Mismo método si aparece otro.
//
// El segundo programa de Instagram ("/Media") que se anticipaba NO existe: al 2026-07-16
// hay un único event_type de Instagram & TikTok en la cuenta. Si lanza, se agrega acá.
const SECOND_BRAIN_ET = 'https://api.calendly.com/event_types/56efc028-ee2f-46e8-852c-e50d45b15b83';
const ABOGADOS_ET = 'https://api.calendly.com/event_types/f8d123ac-364b-47f9-a446-1316fdf37b08';
const LINKEDIN_ET = 'https://api.calendly.com/event_types/96ddf036-9174-459c-be73-b248ad95be13';
const DEVELOPERS_ET = 'https://api.calendly.com/event_types/dff3e48a-4859-417a-98fb-822048aef5d9';
const OPERACIONES_ET = 'https://api.calendly.com/event_types/8462e92a-8210-4bb2-8e2b-583aa3c3d877';
const INSTAGRAM_ET = 'https://api.calendly.com/event_types/d33075cb-d349-43ef-be43-6f80f9c5da03';

// Retia — event_type del programa "Postulación: De Cero a Tactical Investor" (tipo POOL, no sale
// en el query /event_types; derivado de reservas reales el 2026-07-21 con
// scripts/calendly-account-derive.js). Es el ÚNICO ET que pusheamos de esa cuenta: los otros
// tipos de reunión (Revisión de Portafolio, Asesoría, etc.) NO son postulaciones de venta.
const TACTICAL_INVESTOR_ET = 'https://api.calendly.com/event_types/0049872a-7a3f-4e9c-a7d2-d9f88bfc1927';

export const DEFAULT_ACCOUNT = '30x';

export const ACCOUNTS = {
  // Cuenta original: 30X + EstadoX (son marcas distintas, pero UNA sola cuenta de Calendly
  // — la marca se distingue por programa en PROGRAM_PITCH, no por cuenta).
  '30x': {
    key: '30x',
    label: '30X / EstadoX',
    token: () => process.env.CALENDLY_TOKEN || '',
    orgUri: () =>
      process.env.CALENDLY_ORG_URI ||
      'https://api.calendly.com/organizations/9ac5ab82-0c41-43c8-bede-cc9787043b28',
    eventTypes: {
      [SECOND_BRAIN_ET]: 'second_brain',
      [ABOGADOS_ET]: 'abogados',
      [LINKEDIN_ET]: 'linkedin',
      [DEVELOPERS_ET]: 'developers',
      [OPERACIONES_ET]: 'operaciones',
      [INSTAGRAM_ET]: 'instagram',
    },
    // Default true, igual que siempre. En prod está en 'false' (envía de verdad).
    dryRun: () => process.env.CALENDLY_DRY_RUN !== 'false',
    // Default true, igual que siempre. La allowlist fina (CALENDLY_PUSH4_CLOSERS) se
    // aplica ADEMÁS de esto, en el scheduler.
    push4: () => process.env.CALENDLY_PUSH4_ENABLED !== 'false',
    // ¿Los leads de esta cuenta viven en el HubSpot que Juanito tiene conectado?
    // Gobierna el fill de teléfono precall y el modelo nudge. Ver src/hubspot/.
    hubspot: true,
  },

  // Retia — agencia #2. ⚠️ STAGED: configurada y verificada (2026-07-21), pero INERTE hasta que
  // se despliegue el código nuevo + los closers hagan opt-in (arranca muda de todos modos).
  //
  // ⚠️ MODELO IMPORTANTE: este token/org es de UN Calendly que Retia usa SOLO para el programa
  // "De Cero a Tactical Investor". Retia NO tiene un Calendly unificado — es UN CALENDLY POR
  // PROGRAMA. Si Retia suma otro programa, será OTRO token/org → OTRA entrada acá (a diferencia
  // de 30x, cuyo único Calendly sirve 6 programas). Esta asimetría es la que motiva el refactor
  // empresa/programa/closer (ver handoff §18.AJ).
  //
  // Vieira (Juan Pablo Vieira) es la CARA que VENDE el programa (va en el copy del pitch en
  // index.js), NO un closer. Tomó citas en el pasado (12 en la ventana) pero YA NO → está en
  // IGNORED_CLOSERS para no spamear "closer sin mapear". Los closers reales son los de
  // closers.js con account:'retia' (Dana, Andrea, Sebastian Rodriguez).
  retia: {
    key: 'retia',
    label: 'Retia',
    token: () => process.env.CALENDLY_TOKEN_RETIA || '',
    // Org derivada 2026-07-21 (GET /users/me). Hardcodeada como default igual que 30x — el env
    // var CALENDLY_ORG_URI_RETIA es override opcional, no hace falta setearlo.
    orgUri: () =>
      process.env.CALENDLY_ORG_URI_RETIA ||
      'https://api.calendly.com/organizations/fa27fb07-a83b-4a40-9807-6a619b1f652c',
    // Solo el ET de la postulación (pool). Los otros tipos de reunión de este Calendly (Revisión
    // de Portafolio, Asesoría, etc.) NO son ventas → no se pushean.
    eventTypes: {
      [TACTICAL_INVESTOR_ET]: 'tactical_investor',
    },
    // Arranca MUDA: la #2 solo loguea mientras 30X sigue enviando en vivo. Poner
    // CALENDLY_DRY_RUN_RETIA=false recién tras validar un ciclo completo.
    dryRun: () => process.env.CALENDLY_DRY_RUN_RETIA !== 'false',
    // v1: solo pushes precall (0-3). El registro de outcomes se prende acá, no por env.
    push4: () => false,
    // Su CRM no es el HubSpot que Juanito tiene conectado (ese es de 30X).
    hubspot: false,
  },
};

// Cuentas utilizables = las que tienen token. Sin token, la cuenta no existe (mismo patrón
// de auto-desactivación de los jobs del scheduler).
export const activeAccounts = () => Object.values(ACCOUNTS).filter((a) => a.token());

// Cuenta por su key. Devuelve null si no existe.
export const accountOf = (key) => ACCOUNTS[key] || null;

// Mapa plano event_type → programa, de TODAS las cuentas. Los ETs son URIs únicas entre
// organizaciones, así que aplanar no puede colisionar.
export const eventTypeToProgram = () =>
  Object.fromEntries(Object.values(ACCOUNTS).flatMap((a) => Object.entries(a.eventTypes)));

// Cuenta dueña de un programa, o null si el programa no es de ninguna.
// Ojo: para decidir envíos usamos la cuenta del CLOSER (accountOfCloser), no la del
// programa — es total incluso en filas viejas con program NULL. Esta sirve para el copy,
// el guardrail de HubSpot y diagnóstico.
export function accountOfProgram(programKey) {
  if (!programKey) return null;
  for (const acct of Object.values(ACCOUNTS)) {
    if (Object.values(acct.eventTypes).includes(programKey)) return acct;
  }
  return null;
}
