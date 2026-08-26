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

// ─── Metadata declarativa (F3a) ───────────────────────────────────────────────
// Cada Conexión describe, además de sus closures, DE DÓNDE sale cada valor: el nombre de la
// env var y el default que aplica cuando no está. Existe porque una closure no es
// introspectable: `() => process.env.CALENDLY_TOKEN` no dice "CALENDLY_TOKEN" desde afuera, y
// el seed de registries (src/db/registry-seed.js) necesita ese nombre para guardarlo en DB.
// ⚠️ NO se guarda el token, solo el NOMBRE de su variable: los secretos siguen viviendo en el
// `.env`, nunca en la base.
//
// Hoy esto CONVIVE con las closures en vez de reemplazarlas, a propósito: F3a se declara
// "riesgo cero" y reescribir `dryRun` es tocar el camino por el que salen (o no salen) los
// pushes. La red contra la deriva entre las dos representaciones es el test de equivalencia
// `test/data.registry.test.js`, que ejercita ambas con la env prendida, apagada y ausente.
// F3c, que ya tiene que recablear esto, las colapsa en una sola.
//
// Convención del default (la misma que confunde en el scheduler, ver F5 del roadmap):
//   default true  → la env APAGA con 'false'   (`env !== 'false'`)
//   default false → la env PRENDE con 'true'   (`env === 'true'`)
// Sin `env` declarada, el valor es el default fijo y no hay forma de moverlo por entorno.
export const flagFromEnv = (envName, def) => {
  if (!envName) return () => !!def;
  return def
    ? () => process.env[envName] !== 'false'
    : () => process.env[envName] === 'true';
};

export const ACCOUNTS = {
  // Conexión original: 30X + EstadoX (son marcas distintas, pero UNA sola cuenta de Calendly
  // — la marca se distingue por programa, no por conexión; ver programs.js).
  '30x': {
    key: '30x',
    label: '30X / EstadoX',
    // Espejo declarativo de las closures de abajo (ver flagFromEnv). Solo lo lee el seed.
    env: {
      token: 'CALENDLY_TOKEN',
      orgUri: 'CALENDLY_ORG_URI',
      orgUriDefault: 'https://api.calendly.com/organizations/9ac5ab82-0c41-43c8-bede-cc9787043b28',
      dryRun: 'CALENDLY_DRY_RUN',
      dryRunDefault: true,
      push4: 'CALENDLY_PUSH4_ENABLED',
      push4Default: true,
    },
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

  // EstadoX — Calendly PROPIO de la marca (2026-08-25). Arranca MUDO
  // (CALENDLY_DRY_RUN_ESTADOX=true) hasta validar un ciclo de poll completo.
  //
  // Por qué existe: EstadoX vendía "IA para Abogados" desde el Calendly de 30X, y el 2026-07-24
  // abrió el suyo (comunidad@estadox.com). Nadie tocó la config, así que Juanito siguió mirando
  // el ET viejo de la conexión 30x — que desde ese día no recibe una sola reserva. UN MES sin
  // pushes precall para ese programa, sin un error en los logs: el poll no distingue "no hubo
  // citas" de "estoy mirando el Calendly equivocado". Detectado porque la línea "📅 Bookearon
  // Calendly" del reporte de las 8pm marcaba 0 todos los días.
  //
  // ⚠️ Su ET es POOL y NO sale en /event_types (ver el comentario largo en programs.js). Al
  // agregar otro programa a esta conexión, sacar el UUID de las reservas reales, no del listado.
  //
  // El CRM NO cambió: los leads de abogados siguen en el HubSpot que Juanito tiene conectado (el
  // de 30X) ⇒ hubspot:true, igual que antes de la mudanza.
  estadox: {
    key: 'estadox',
    label: 'EstadoX',
    // push4 sin `env`, como retia: es un `false` FIJO. No es una decisión de producto nueva sino
    // preservar lo que ya pasaba — el Push 4 está gateado ADEMÁS por CALENDLY_PUSH4_CLOSERS, y
    // ninguno de los dos closers de esta conexión está en esa allowlist. Prenderlo acá sin
    // tocar la allowlist no cambiaría nada, y tocarla es una decisión aparte.
    env: {
      token: 'CALENDLY_TOKEN_ESTADOX',
      orgUri: 'CALENDLY_ORG_URI_ESTADOX',
      orgUriDefault: 'https://api.calendly.com/organizations/1a31340a-2bd5-46ad-8d04-05eae61bb1d9',
      dryRun: 'CALENDLY_DRY_RUN_ESTADOX',
      dryRunDefault: true,
      push4: null,
      push4Default: false,
    },
    token: () => process.env.CALENDLY_TOKEN_ESTADOX || '',
    // Org derivada 2026-08-25 (GET /users/me con el PAT de comunidad@estadox.com → HTTP 200).
    // Hardcodeada como default igual que 30x/retia; el env var es override opcional.
    orgUri: () =>
      process.env.CALENDLY_ORG_URI_ESTADOX ||
      'https://api.calendly.com/organizations/1a31340a-2bd5-46ad-8d04-05eae61bb1d9',
    // Derivado de programs.js: los ETs de los programas cuya connection es 'estadox'
    // (hoy solo abogados).
    eventTypes: eventTypesForConnection('estadox'),
    // Arranca MUDA: solo loguea hasta confirmar que el poll ve las citas y que el mapeo de
    // hosts → closers resuelve. Poner CALENDLY_DRY_RUN_ESTADOX=false tras validar un ciclo.
    dryRun: () => process.env.CALENDLY_DRY_RUN_ESTADOX !== 'false',
    push4: () => false,
    // Mismo HubSpot que 30x: la marca cambió de Calendly, no de CRM.
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
    // push4 sin `env`: es un `false` FIJO (v1 de Retia = solo pushes precall 0-3), no una
    // variable que alguien pueda prender por entorno. El seed guarda esa diferencia.
    env: {
      token: 'CALENDLY_TOKEN_RETIA',
      orgUri: 'CALENDLY_ORG_URI_RETIA',
      orgUriDefault: 'https://api.calendly.com/organizations/fa27fb07-a83b-4a40-9807-6a619b1f652c',
      dryRun: 'CALENDLY_DRY_RUN_RETIA',
      dryRunDefault: true,
      push4: null,
      push4Default: false,
    },
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

  // ComunicArte — conexión #4 (2026-08-25). Es el SEGUNDO Calendly de **Retia**, no el de otra
  // empresa: Retia opera un Calendly POR PROGRAMA (ver la entrada `retia` arriba), así que su
  // segundo programa —"Método Comunicarte"— trae su propia cuenta
  // (info@eventoscomunicarte.com, org derivada con GET /users/me → HTTP 200). Por eso este es hoy
  // el único caso de empresa ≠ conexión del sistema. Arranca MUDA
  // (CALENDLY_DRY_RUN_COMUNICARTE=true) hasta validar un ciclo de poll completo, igual que
  // arrancaron retia y estadox.
  //
  // ⚠️ Su ET es POOL y NO sale en /event_types, y además hay un ET *solo* homónimo que sí sale y
  // está muerto: ver el comentario largo en programs.js antes de tocar el UUID.
  //
  // ⚠️ BLOQUEANTE conocido al darla de alta: las reservas de este Calendly llegan SIN TELÉFONO del
  // lead (30 de 30 muestreadas), así que hoy todos sus pushes degradan a "(mándalo manual)" — sin
  // link wa.me no hay push que valga. Es config del lado de Calendly. Detalle en programs.js.
  comunicarte: {
    key: 'comunicarte',
    // El label sale en las alertas al admin: lleva la empresa adelante para que "ComunicArte" no
    // se lea como un cliente aparte de Retia.
    label: 'Retia · ComunicArte',
    // push4 sin `env`, como retia y estadox: `false` FIJO. v1 de una conexión nueva = solo
    // pushes precall 0-3. Prenderlo es una decisión aparte, no un default.
    env: {
      token: 'CALENDLY_TOKEN_COMUNICARTE',
      orgUri: 'CALENDLY_ORG_URI_COMUNICARTE',
      orgUriDefault: 'https://api.calendly.com/organizations/d84e158d-a001-40c8-9eab-f9cb8eef312e',
      dryRun: 'CALENDLY_DRY_RUN_COMUNICARTE',
      dryRunDefault: true,
      push4: null,
      push4Default: false,
    },
    token: () => process.env.CALENDLY_TOKEN_COMUNICARTE || '',
    orgUri: () =>
      process.env.CALENDLY_ORG_URI_COMUNICARTE ||
      'https://api.calendly.com/organizations/d84e158d-a001-40c8-9eab-f9cb8eef312e',
    eventTypes: eventTypesForConnection('comunicarte'),
    dryRun: () => process.env.CALENDLY_DRY_RUN_COMUNICARTE !== 'false',
    push4: () => false,
    // NO declara `sheets`: el Push 5 del Sheet de Comunicarte hoy cuelga de la conexión `retia`
    // (son los closers de Retia los que lo llenan). Mover o duplicar ese recordatorio acá es una
    // decisión de operación, no un detalle de esta alta.
    // Su CRM no es el HubSpot que Juanito tiene conectado.
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
