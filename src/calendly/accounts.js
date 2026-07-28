// src/calendly/accounts.js
// Registro de CONEXIONES de Calendly (el código las llama "account"/ACCOUNTS por historia;
// en el modelo nuevo son Conexiones — ver ADR 0001). Una Conexión es lo que distingue una
// cuenta de Calendly de otra: su token, su organización y qué features aplican (dry-run,
// Push 4, HubSpot). Los event_types de cada Conexión y todo lo del PROGRAMA viven ahora en
// programs.js; acá solo se DERIVAN los eventTypes que a cada Conexión le tocan.
//
// Por qué existe: Juanito nació atendiendo UNA cuenta (30X/EstadoX) y todo eso vivía como
// singleton en index.js (un TOKEN, un ORG_URI, una lista de ETs). Al sumar una agencia con
// su PROPIA cuenta de Calendly, ese tuple deja de ser único → se vuelve una tabla.
//
// Cómo se agrega una CONEXIÓN nueva:
//   1. Resolver org URI y event_types contra la cuenta real. Atajo: con el token en el .env,
//      `node scripts/calendly-account-derive.js <key>` imprime org URI, los event_types (incluye
//      los tipo POOL, que NO salen por API — se leen de reservas reales) y los hosts para verificar
//      closers. Hardcodear org URI acá (como 30x/retia); el ET va en programs.js.
//   2. Agregar la entrada acá con su token por env.
//   3. ⚠️ Pasar sus env (CALENDLY_TOKEN_<KEY>, CALENDLY_DRY_RUN_<KEY>) en docker-compose.yml: el
//      compose pasa env EXPLÍCITAMENTE → sin esas líneas el token del .env NO llega al contenedor
//      y la cuenta no entra a activeAccounts(). (Nos pasó con retia el 2026-07-21.)
//   4. Agregar el/los programa(s) de esa Conexión en programs.js (con connection:'<key>').
//   5. Agregar sus closers en closers.js (identidad con connection:'<key>').
//
// AUTO-DESACTIVACIÓN: `activeAccounts()` filtra por token presente, igual que todos los
// jobs del scheduler (stripe-alerts, sheets-report). Una cuenta sin su token simplemente
// no existe y el sistema se comporta como si nunca se hubiera agregado.

import { eventTypesForConnection, connectionOfProgram, eventTypeToProgram } from './programs.js';

// Re-exportado para callers viejos que lo importan desde acá (index.js). El mapa vive en
// programs.js — este archivo ya no conoce los event_types uno por uno.
export { eventTypeToProgram };

export const DEFAULT_ACCOUNT = '30x';

export const ACCOUNTS = {
  // Conexión original: 30X + EstadoX (son marcas distintas, pero UNA sola cuenta de Calendly
  // — la marca se distingue por programa, no por conexión; ver programs.js).
  '30x': {
    key: '30x',
    label: '30X / EstadoX',
    token: () => process.env.CALENDLY_TOKEN || '',
    orgUri: () =>
      process.env.CALENDLY_ORG_URI ||
      'https://api.calendly.com/organizations/9ac5ab82-0c41-43c8-bede-cc9787043b28',
    // Derivado de programs.js: los ETs de los programas cuya connection es '30x'. Objeto
    // { ET: programKey } (los callers hacen Object.keys/Object.values sobre él).
    eventTypes: eventTypesForConnection('30x'),
    // Default true, igual que siempre. En prod está en 'false' (envía de verdad).
    dryRun: () => process.env.CALENDLY_DRY_RUN !== 'false',
    // Default true, igual que siempre. La allowlist fina (CALENDLY_PUSH4_CLOSERS) se
    // aplica ADEMÁS de esto, en el scheduler.
    push4: () => process.env.CALENDLY_PUSH4_ENABLED !== 'false',
    // ¿Los leads de esta cuenta viven en el HubSpot que Juanito tiene conectado?
    // Gobierna el fill de teléfono precall y el modelo nudge. Ver src/hubspot/.
    hubspot: true,
  },

  // Retia — agencia #2. Configurada y verificada (2026-07-21). Arranca MUDA
  // (CALENDLY_DRY_RUN_RETIA=true) hasta validar un ciclo completo.
  //
  // ⚠️ MODELO IMPORTANTE: este token/org es de UN Calendly que Retia usa SOLO para el programa
  // "De Cero a Tactical Investor". Retia NO tiene un Calendly unificado — es UN CALENDLY POR
  // PROGRAMA. Si Retia suma otro programa con su propio Calendly, será OTRA entrada acá (a
  // diferencia de 30x, cuyo único Calendly sirve 6 programas). Esa asimetría es lo que motivó
  // el modelo empresa/programa/conexión de primera clase (ADR 0001).
  //
  // El copy y el ET del programa viven en programs.js (tactical_investor). Vieira VENDE el
  // programa (la CARA del pitch), NO es closer → está en IGNORED_CLOSERS. Los closers reales
  // son los de closers.js con connection:'retia' (Dana, Andrea, Sebastian Rodriguez).
  retia: {
    key: 'retia',
    label: 'Retia',
    token: () => process.env.CALENDLY_TOKEN_RETIA || '',
    // Org derivada 2026-07-21 (GET /users/me). Hardcodeada como default igual que 30x — el env
    // var CALENDLY_ORG_URI_RETIA es override opcional, no hace falta setearlo.
    orgUri: () =>
      process.env.CALENDLY_ORG_URI_RETIA ||
      'https://api.calendly.com/organizations/fa27fb07-a83b-4a40-9807-6a619b1f652c',
    // Derivado de programs.js: los ETs de los programas cuya connection es 'retia'
    // (hoy solo tactical_investor).
    eventTypes: eventTypesForConnection('retia'),
    // Arranca MUDA: la #2 solo loguea mientras 30X sigue enviando en vivo. Poner
    // CALENDLY_DRY_RUN_RETIA=false recién tras validar un ciclo completo.
    dryRun: () => process.env.CALENDLY_DRY_RUN_RETIA !== 'false',
    // v1: solo pushes precall (0-3). El registro de outcomes se prende acá, no por env.
    push4: () => false,
    // Los dos Sheets que los closers de Retia llenan después de CADA call (Push 5, §18.AP).
    // La lista ES el interruptor: una conexión sin `sheets` no recibe el recordatorio, que es
    // como queda 30x (no declara el campo). Ojo con la numeración: Retia NO tiene Push 4 —ver
    // la línea de arriba—, así que este es su ÚNICO push post-call. El 5 no es un typo, el 4
    // está ocupado por el registro de outcomes de 30x.
    sheets: [
      {
        label: 'De Cero a Tactical Investor',
        url: 'https://docs.google.com/spreadsheets/d/1DBKL4zwWWeJppe-6mzpJ4jT1G6MdEmT1Dd_uMiNBNwc/edit?gid=0#gid=0',
      },
      {
        label: 'Comunicarte',
        url: 'https://docs.google.com/spreadsheets/d/1NN6rlZXJJcgvWXYsbP99vLt9aj7FXVPd6ep4ULAcK54/edit?gid=1633631553#gid=1633631553',
      },
    ],
    // Su CRM no es el HubSpot que Juanito tiene conectado (ese es de 30X).
    hubspot: false,
  },
};

// Cuentas utilizables = las que tienen token. Sin token, la cuenta no existe (mismo patrón
// de auto-desactivación de los jobs del scheduler).
export const activeAccounts = () => Object.values(ACCOUNTS).filter((a) => a.token());

// Cuenta por su key. Devuelve null si no existe.
export const accountOf = (key) => ACCOUNTS[key] || null;

// Cuenta (Conexión) dueña de un programa, o null si el programa no es de ninguna. Se deriva
// de la connection que el programa declara en programs.js.
// Ojo: para decidir envíos usamos la cuenta del CLOSER (accountOfCloser), no la del programa
// — es total incluso en filas viejas con program NULL. Esta sirve para el copy, el guardrail
// de HubSpot y diagnóstico.
export function accountOfProgram(programKey) {
  const connKey = connectionOfProgram(programKey);
  return connKey ? accountOf(connKey) : null;
}
