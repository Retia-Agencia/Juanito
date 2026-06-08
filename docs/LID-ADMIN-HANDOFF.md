# Handoff — BOSS_LID / ADMIN_LID (acceso de jefe por LID)

> Continuación del trabajo sobre el blocker de LID del opt-in de closers.
> Rama: `feat/admin-lid-testing` (local, sin push). Última sesión: 2026-06-07.
> Relacionado: `docs/CALENDLY-HANDOFF.md` (sección "⚠️ BLOCKER: opt-in roto por LID").

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

## Estado de los LIDs (IMPORTANTE — leer)

| LID | Quién es | Dónde va |
|---|---|---|
| `129446371655733@lid` | **Alejandro** (dev/tester) | `ADMIN_LID` ✅ confirmado en vivo |
| `147313234280449@lid` | **Compañero** (dev/tester) | `ADMIN_LID` ✅ (también lo pegó el otro dev) |
| `147313234280449@lid` | — en `BOSS_LID` | **⚠️ PLACEHOLDER, NO es el jefe real** |
| LID real del **jefe** | quien tiene `BOSS_PHONE=573105643297` | **DESCONOCIDO — pendiente de capturar** |

**El `147313234280449@lid` que quedó en `BOSS_LID` es del compañero, no del jefe.** Era un valor
de prueba heredado del handoff/`.env.example`. El LID real del jefe nunca se ha capturado.

## ⚠️ Riesgo a no olvidar antes de desplegar

Si se despliega al VPS con `BOSS_LID` apuntando a un LID que **no** es el del jefe real, los DMs
del jefe (que llegan como `@lid` desconocido) **dejarían de reconocerse como jefe** → se irían al
flujo de opt-in y el bot los ignoraría. Es decir, **se rompería el chat del jefe con Juanito**.
→ **Capturar el LID real del jefe ANTES de cualquier deploy con `BOSS_LID`.**

## Cómo capturar un LID (receta probada)

El bot solo loguea el LID donde está conectado a WA = el **contenedor del VPS** (local no sirve:
`better-sqlite3` no compila en Windows y no hay sesión de WA). Pasos:

```powershell
# 1. Tail en vivo de los logs del VPS, filtrando la línea de ruteo:
plink -batch -pw <PASSWORD> root@157.230.152.202 ^
  "cd /root/juanito && docker compose logs -f --since 1s 2>&1 | grep --line-buffered -iE 'DM de LID'"
# 2. La persona le escribe 'Hola' a Juanito desde su celular.
# 3. Aparece:  [Main] DM de LID no resuelto: <lid>@lid — tratando como jefe
#    (en el VPS corre código viejo sin BOSS_LID, por eso dice 'tratando como jefe')
# 4. Copiar el <lid>@lid y pegarlo donde corresponda (BOSS_LID o ADMIN_LID).
```

- VPS: DigitalOcean `157.230.152.202`, código en `/root/juanito` (NO es repo git; se sincroniza con `pscp`).
- SSH solo por contraseña como `root`. **Rotar esa contraseña** (pasó por chat). `plink`/`pscp` ya instalados en la máquina de Alejandro (`C:\Program Files\PuTTY\`).
- El LID propio del bot es `31302527013028@lid` → **ignorarlo**, no es de ninguna persona.

## Próximos pasos (en orden)

1. **Capturar el LID real del jefe** (que el jefe le escriba a Juanito; usar la receta de arriba) y
   poner ese valor en `BOSS_LID` (reemplazando el placeholder del compañero).
2. **Confirmar/ajustar `ADMIN_LID`** con los testers reales (hoy: Alejandro + compañero).
3. **Merge de `feat/admin-lid-testing` a `main`** (y push si se decide).
4. **Deploy al VPS** con el código nuevo + `.env` del VPS con `BOSS_LID` real y `ADMIN_LID`:
   - `pscp -r src root@157.230.152.202:/root/juanito/` (o el set de archivos que cambien).
   - Editar el `.env` del VPS (hoy NO tiene `BOSS_LID`/`ADMIN_LID`).
   - `docker compose up -d --build`. Cada recreación = 1 reconexión de WA (controlada por `entrypoint.sh`).
5. **Verificar el opt-in self-service de un closer real** (lo que el blocker original impedía):
   que un closer le escriba "Hola" y reciba "Quedaste registrado ✅" en vez de la respuesta de jefe.
   Confirmar con `docker compose exec agent node scripts/calendly-optins.js`.

## Estado del repo

- Rama actual: `feat/admin-lid-testing` (local, **sin push**).
- Commit: `9836819` "feat(lid): ADMIN_LID para acceso de jefe en pruebas" — solo `src/index.js`.
- `main` intacto. VPS sin tocar (sigue con código viejo, sin `BOSS_LID`).
- `.env` local con los valores de arriba (no commiteado, gitignored).

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

1. **Memoria del jefe sandboxed**: que el jefe pueda hacer que Juanito "recuerde" cosas suyas, pero
   en un namespace que NO altera el comportamiento del sistema (hoy simplemente no tiene `save_memory`).
2. **Comandos de admin**: `/whoami` (devuelve tu LID — quita el dolor de grepear logs), `/status`
   (DRY_RUN, último push, salud de WA, # opt-ins), `/dryrun on|off`, `/optins`.
3. **No mandar a terceros por orden del jefe** (anti-ban + reputación) cuando se agreguen tools de envío.
4. **Cola de aprobación**: pedido gateado del jefe → Juanito avisa a un admin → admin aprueba.
5. **Log de auditoría** de lo que el jefe pide (y qué quedó gateado).
6. **Caps anti-ban / costo**: tope de mensajes salientes/min y de tokens por conversación.

## Verificación rápida (tests)

```powershell
node --test test/calendly.helpers.test.js   # 13/13 al cierre de esta sesión
```
Nota: el ruteo de `src/index.js` (`onMessage`) hoy NO tiene tests (conecta a WA al cargar el módulo).
Mejora opcional: extraer la lógica "¿es jefe?" a una función pura y cubrirla con tests.
