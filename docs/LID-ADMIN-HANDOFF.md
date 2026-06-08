# Handoff — BOSS_LID / ADMIN_LID (acceso de jefe por LID)

> Continuación del trabajo sobre el blocker de LID del opt-in de closers.
> Todo MERGEADO a `main`, PUSHEADO y DESPLEGADO. Última sesión: 2026-06-08.
> Relacionado: `docs/CALENDLY-HANDOFF.md` (sección "⚠️ BLOCKER: opt-in roto por LID").

## ✅ ESTADO ACTUAL (2026-06-08) — leer primero

El **blocker original (opt-in roto por LID) está RESUELTO end-to-end y validado en vivo.**

- **`BOSS_LID` real capturado y desplegado:** `144268136038585@lid` (el jefe le escribió a Juanito;
  capturado por logs). En el `.env` del VPS y en el `.env` local.
- **`ADMIN_LID` desplegado:** `129446371655733@lid` (Alejandro) + `147313234280449@lid` (compañero) → rol admin.
- **Tiering de capacidades activo** (roles + memoria sandboxed + comandos), desplegado y validado:
  `/whoami` → `Rol: admin`, `/status` responde.
- **Opt-in self-service validado:** Sebastian Rodriguez (`20671711162446@lid`) le escribió "Hola Juanito",
  el sistema lo resolvió por `pushName` → "Closer ya registrado". Ya no se trata como jefe. ✅
- **Setup de pruebas Calendly:** Pablo Lozano eliminado de opt-ins; **solo Sebastian Rodriguez**
  (`573102212005`) está opted-in. **Fase 1 (datos/formato) validada en dry-run.** Falta **Fase 2
  (envío real)** → próxima sesión. Calendly sigue en `DRY_RUN=true` (no envía nada).

Pendientes reales: **Fase 2 envío real**; rotar `CALENDLY_TOKEN` y la contraseña del VPS (pasaron por chat).

Lo de abajo es el historial detallado de cómo se llegó acá.

## Contexto en una frase

El opt-in self-service de closers está roto porque WA multi-device manda los DMs como
`<num>@lid` (no el teléfono), y el código trataba **cualquier** `@lid` no resuelto como jefe.
El commit `ee103b0` (del otro dev) introdujo `BOSS_LID` para identificar al jefe por su LID
específico. Esta sesión agregó **`ADMIN_LID`** para que el equipo (Alejandro + compañero)
pueda probar como "jefe" desde su celular **sin rotar `BOSS_LID`**.

## Qué se hizo en esta sesión

1. **Código — `src/index.js`** (rama `feat/admin-lid-testing`, commit `9836819`):
   - Nuevo `ADMIN_LIDS()` que parsea `process.env.ADMIN_LID` como CSV de `@lid`.
   - `isBoss` ahora es: `phone == BOSS_PHONE  ||  (es @lid  &&  (no hay BOSS_LID  ||  lid == BOSS_LID  ||  lid ∈ ADMIN_LID))`.
   - El log distingue `LID del jefe` vs `LID del admin`.
   - **Retrocompatible:** si `BOSS_LID` está vacío, sigue el comportamiento viejo (cualquier `@lid` = jefe).
   - `.env.example` NO se tocó (decisión del usuario).

2. **`.env` local** (no va a git, está en `.gitignore`):
   - `BOSS_LID=147313234280449@lid` → **⚠️ PLACEHOLDER**, ver abajo.
   - `ADMIN_LID=129446371655733@lid,147313234280449@lid`.

3. **Captura de LIDs en vivo** vía tail de los logs del VPS (`docker compose logs -f`):
   - Se confirmó el LID de **Alejandro**: `129446371655733@lid` (le escribió a Juanito, apareció en los logs).

## Estado de los LIDs (todos capturados — 2026-06-08)

| LID | Quién es | Rol / dónde |
|---|---|---|
| `144268136038585@lid` | **Jefe real** (`BOSS_PHONE=573105643297`) | `BOSS_LID` ✅ capturado en vivo y desplegado |
| `129446371655733@lid` | **Alejandro** (dev) | `ADMIN_LID` → rol admin ✅ |
| `147313234280449@lid` | **Compañero** (dev) | `ADMIN_LID` → rol admin ✅ |
| `20671711162446@lid`  | **Sebastian Rodriguez** (closer, sujeto de prueba) | `unknown` → flujo de opt-in ✅ |
| `31302527013028@lid`  | El bot (Juanito) mismo | ignorar, no es de nadie |

> Histórico: el `147...@lid` estuvo un tiempo en `BOSS_LID` como **placeholder** (era del compañero,
> no del jefe). Ya se reemplazó por el LID real del jefe `144268136038585@lid`.

## Cómo capturar un LID

**La forma fácil ahora: comando `/whoami`.** Quien escriba `/whoami` a Juanito recibe su propio
`<lid>@lid` y rol en la respuesta — sin tocar logs. (Funciona para cualquiera, también un admin nuevo.)

Alternativa por logs (útil cuando la persona es no-técnica y solo manda "Hola"). El bot solo loguea
donde está conectado a WA = el **contenedor del VPS** (local no sirve: `better-sqlite3` no compila en
Windows y no hay sesión de WA). Pasos:

```powershell
# 1. Tail en vivo de los logs del VPS, filtrando la línea de ruteo:
plink -batch -pw <PASSWORD> root@157.230.152.202 ^
  "cd /root/juanito && docker compose logs -f --since 1s 2>&1 | grep --line-buffered -iE 'DM de LID'"
# 2. La persona le escribe 'Hola' a Juanito desde su celular.
# 3. Para el jefe/admin aparece:  [Main] DM de LID del boss|admin: <lid>@lid
#    Para un @lid desconocido (closer) NO hay log (va al opt-in en silencio) → usa /whoami
#    o filtra por 'Debug.*rawJid' para ver su <lid>@lid crudo.
# 4. Copiar el <lid>@lid y pegarlo donde corresponda (BOSS_LID o ADMIN_LID).
# OJO: el primer mensaje de un número NUEVO llega vacío (handshake de cifrado); pedir un 2º.
```

- VPS: DigitalOcean `157.230.152.202`, código en `/root/juanito` (NO es repo git; se sincroniza con `pscp`).
- SSH solo por contraseña como `root`. **Rotar esa contraseña** (pasó por chat). `plink`/`pscp` ya instalados en la máquina de Alejandro (`C:\Program Files\PuTTY\`).
- El LID propio del bot es `31302527013028@lid` → **ignorarlo**, no es de ninguna persona.

## Próximos pasos (próxima sesión)

1. **[Fase 2] Envío real controlado del push a Sebastian.** Receta probada (ver `docs/CALENDLY-HANDOFF.md`):
   - Editar `.env` del VPS: `CALENDLY_DRY_RUN=false` + `CALENDLY_PUSH1_CRON=<minuto+5> <hora> * * *`
     (o `PUSH2_CRON`) a unos minutos en el futuro.
   - `docker compose up -d` (recrea con la nueva env; 1 reconexión de WA).
   - Esperar el minuto del cron (runPush1 tarda ~40s por el throttle de invitees), verificar en logs
     `[Calendly] enviado (push1) → 573102212005` y que Sebastian reciba el mensaje.
   - **Revertir:** `CALENDLY_DRY_RUN=true`, quitar el cron de prueba, `docker compose up -d`.
   - Solo Sebastian recibe (único opt-in); el resto sale `OMITIDO ... sin opt-in`.
   - ⚠️ Un `docker compose exec node -e` NO puede enviar WhatsApp (proceso separado, sin socket WA).
     El envío real debe salir del proceso principal vía el cron.
2. **Rotar `CALENDLY_TOKEN`** (es el PAT personal de Sebastian Rodriguez, pasó por chat) y la
   **contraseña del VPS** (también pasó por chat).
3. Roadmap de baby-proofing restante (cola de aprobación, auditoría, caps anti-ban) — ver más abajo.

## Estado del repo (2026-06-08)

- **`main`** tiene todo (la rama `feat/admin-lid-testing` ya se fast-forward-mergeó y se borró el flujo).
  Commits clave: `dd2e101` tiering, `9757ff5` memoria sandboxed, `448d627` comandos, `cde8a8b` fix compose.
- **Pusheado** a `origin` (github.com/Agencia-Dani/Juanito) y **desplegado** en el VPS.
- `.env` local (gitignored): `BOSS_LID=144268136038585@lid`, `ADMIN_LID=129...,147...`.

## Tiering de capacidades (baby-proofing) — el jefe es no-técnico y rompe cosas

El objetivo: el jefe se siente dueño, pero está **sandboxed**; el equipo (admins) tiene el
control real. `BOSS_LID`/`ADMIN_LID` ya no son solo ruteo — ahora definen **poder**.

### Implementado (commit `dd2e101`)

- **`src/common/roles.js` — `roleOf(sender)` → `admin | boss | unknown`** (fuente única de verdad).
  `admin` gana sobre `boss` (un LID en `ADMIN_LID` es admin aunque esté también en `BOSS_LID`).
- **Gateo de tools por rol a nivel de API** (`toolsForRole` en `src/claude/index.js`): el jefe
  **no** recibe `save_memory` (su vector de envenenamiento de la memoria del bot); el admin sí.
  Lo que no está en el array de tools, el modelo no lo puede invocar — más fuerte que pedirlo en el prompt.
- **Defensa en profundidad** en `dispatchTool`: `save_memory` con rol ≠ admin se rechaza.
- **System prompt endurecido**: nunca revelar config/tokens/closers/teléfonos; al jefe nunca
  errores técnicos y deflectar con calidez ("eso lo coordina tu equipo") en vez de negarse en seco;
  al admin, modo técnico.
- Tests: `test/roles.test.js` + guarda de `save_memory` por rol en `test/brain.tools.test.js`.

### Roadmap pendiente (en orden sugerido)

1. ✅ **Memoria del jefe sandboxed** (commit `9757ff5`): tool `remember_note` (boss+admin) guarda
   notas del jefe en namespace `boss_note:`; el system prompt las presenta como DATOS, no
   instrucciones. `save_memory` quedó solo-admin (memoria núcleo). `splitMemory` separa núcleo
   vs notas. Cierra la regresión de quitarle `save_memory` al jefe.
2. ✅ **Comandos de admin** (commit `448d627`): `/whoami` (cualquiera; devuelve tu LID y rol —
   reemplaza el grepeo de logs) y `/status` (solo admin; WA, uptime, token Calendly, DRY_RUN,
   require opt-in, # opt-ins). En `src/bot/commands.js`, interceptados en `onMessage`.
   Pendientes opcionales: `/dryrun on|off`, `/optins`.
3. **No mandar a terceros por orden del jefe** (anti-ban + reputación). DIFERIDO a propósito: se
   implementa JUNTO con la feature de envío, porque el enfoque depende de esa arquitectura.
4. **Cola de aprobación**: pedido gateado del jefe → Juanito avisa a un admin → admin aprueba.
5. **Log de auditoría** de lo que el jefe pide (y qué quedó gateado).
6. **Caps anti-ban / costo**: tope de mensajes salientes/min y de tokens por conversación.

## ⚠️ Gotcha de deploy: las env vars se pasan EXPLÍCITAS en docker-compose.yml

El `docker-compose.yml` enumera una a una las vars que entran al contenedor (`environment:`).
**Una var en el `.env` del VPS NO llega al contenedor si no está listada ahí.** Mordió en el
deploy del 2026-06-08: se agregó `ADMIN_LID` al `.env` pero el rol seguía cayendo a `boss` porque
el compose no la pasaba (y el `BOSS_LID` del fix previo `ee103b0` tampoco llegaba nunca). Fix:
commit `cde8a8b`. **Regla: toda env var nueva que el código lea debe agregarse también al
`environment:` del compose.**

## Estado del deploy (2026-06-08)

- ✅ `main` desplegado en el VPS (`pscp src` + `pscp docker-compose.yml` + `docker compose up -d --build`).
  WA reconectó con la sesión existente, sin re-vincular. Calendly sigue en `DRY_RUN=true`.
- ✅ `.env` del VPS: `BOSS_LID=144268136038585@lid` (jefe real, capturado en vivo) +
  `ADMIN_LID=129446371655733@lid,147313234280449@lid` (Alejandro + compañero).
- ✅ Validado en vivo: `/whoami` → `Rol: admin`, `/status` responde; opt-in self-service de Sebastian OK.
- Rollback: `/root/juanito-backup-20260608-022526.tar.gz` + imagen `juanito-agent:pre-roles-20260608`.

## Pruebas de pushes Calendly (sujeto: Sebastian Rodriguez)

- **Opt-ins:** se eliminó a Pablo Lozano; **solo Sebastian Rodriguez** (`573102212005`,
  `sebastian@30x.com`) está opted-in. (No hay función `deleteOptin`; el borrado se hizo por SQL
  directo en `/app/data/brain.sqlite` vía `docker compose exec`.)
- **Fase 1 (datos/formato) — ✅ validada.** `node scripts/calendly-day-check.js 2026-06-08 "sebastian@30x.com"`
  (corre local con el token del `.env`) → 2 citas el 8-jun, scoping por día OK. Y la pasada
  `docker compose exec -T agent node scripts/calendly-dryrun.js` (en el VPS, dry-run) renderizó su
  Push 1 correcto: nombres completos, teléfonos, horas y conteo.
- **Fase 2 (envío real) — pendiente** (próxima sesión, receta en "Próximos pasos").

## Aprendizaje: primer contacto en Baileys llega VACÍO

El **primer** mensaje de un número nuevo a Juanito llega sin contenido (`types=` vacío, `msg.message`
nulo) mientras se establece la sesión de cifrado; el bot lo descarta en `if (!text) return`. El
**segundo** mensaje ya llega con texto. Pasó con Sebastian: 1er "Hola" vacío, 2º "Hola Juanito" OK.
→ Si un closer dice que escribió y "no pasó nada", pedirle que mande un segundo mensaje.

## Verificación rápida (tests)

```powershell
node --test test/calendly.helpers.test.js   # 13/13 al cierre de esta sesión
```
Nota: el ruteo de `src/index.js` (`onMessage`) hoy NO tiene tests (conecta a WA al cargar el módulo).
Mejora opcional: extraer la lógica "¿es jefe?" a una función pura y cubrirla con tests.
