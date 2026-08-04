# Dashboard centralizado de Juanito — Roadmap

> **Estado: F1, F2, F3a y F3b COMPLETAS y en producción** (2026-07-30). El dashboard corre en
> **`https://juanito.tail2df10b.ts.net`** con `DASH_WRITES=todo` (los 8 tabs escriben, 21 acciones)
> y el botón Deploy activo, **sin haber reiniciado el bot ni una vez** en toda la construcción. El
> round-trip dashboard → `settings` → `/calendly` está verificado en producción sin tocar a ningún
> closer real (§F2). Los registries ya tienen tablas, seed y test de equivalencia, pero **nadie los
> lee todavía** (§F3).
>
> **Próximo paso: F3c** — que el runtime lea de la DB detrás de `REGISTRY_SOURCE_*`, un registry a
> la vez. Es el primer paso de F3 que puede cambiar comportamiento. Alternativa independiente: **F6**
> (pase de diseño Jarvis).
>
> ✅ **El arreglo de la interfaz está desplegado** (`785c2cf`, 2026-07-30, `alcance: dash`). Los 13
> tabs renderizan en producción y el bot no se reinició (`Up 22 hours`, `StartedAt` intacto).
>
> ⚠️ **F3a/F3b están en `main` pero NO desplegadas.** Tocan `src/`, así que exigen `alcance: todo`
> → rebuild de imagen y **reconexión de Baileys**. No corre prisa y conviene que viajen
> acompañadas. Ver "Cómo desplegar F3a".
> **Fuente de verdad de este proyecto.** Si retomas en otra sesión, lee este archivo completo antes
> de tocar nada. Decisión arquitectónica formal en [ADR 0002](adr/0002-dashboard-y-superficie-http.md).

## Cómo retomar en frío

1. Lee este archivo entero (son ~15 min y te ahorran repetir la discusión).
2. `git log --oneline -10` y revisa qué casillas de abajo están marcadas. F2 ya está mergeada en
   `main` y desplegada (la rama `feat/dashboard-f2-escrituras` quedó como rastro, se puede borrar).
   El pipeline despliega **`main`** (`ref: main`): lo que no esté empujado ahí, no está en el VPS.
3. Revisa la tabla **Interruptores y sus defaults** para saber en qué estado quedó el sistema.
4. Sigue por la primera casilla sin marcar. Las fases son independientes y pausables.

### Lo único que quedó pendiente de F1 (necesita acción humana)

- [x] **Dos Repository secrets** en Settings → Secrets and variables → Actions (pestaña *Secrets*,
      **no** Environment secrets: el workflow no declara `environment:`, así que los de entorno
      llegarían vacíos): `VPS_HOST` = `157.230.152.202` y `VPS_PASSWORD` = el `VPS_KEY` del `.env`.
      **Creados el 2026-07-30.** El workflow ya puede correr desde la pestaña Actions.
- [x] **Botón Deploy en la UI** — [dashboard/server/deploy.js](../dashboard/server/deploy.js),
      `POST /api/deploy` → `workflow_dispatch`. Dos botones en el lateral (`dash` y `todo`), con
      confirmación distinta: el de `todo` avisa que reconstruye la imagen y **reconecta WhatsApp**.
      ✅ **Token configurado el 2026-07-30.** `DASH_GITHUB_TOKEN` en el `.env` del VPS, un PAT
      fine-grained con `actions:write` sobre el repo. Es un secreto del **contenedor**, no un
      Repository secret (esos los usa el workflow; este lo dispara). Sin token la ruta no existe y
      la UI no dibuja los botones, que es el default seguro. Verificado: `/api/meta` responde
      `deploy: true`, el log del dash dice `deploy ON`, y el token autentica contra
      `GET /repos/Agencia-Dani/Juanito/actions/workflows/deploy.yml` (`state: active`). El permiso
      de **escritura** solo queda probado el día que se apriete el botón; hasta entonces el camino
      probado es `gh workflow run deploy.yml -f alcance=dash`, que ya corrió tres veces.

## Entrar al dashboard (el paso que falta)

`https://juanito.tail2df10b.ts.net` es un nombre de **MagicDNS**: existe solo dentro del tailnet.
Desde una máquina que no esté en él, el navegador da `DNS_PROBE_FINISHED_NXDOMAIN`, y eso **no es
una falla, es el diseño** (la red es la auth: no hay login porque no hay puerta pública).

Medido el 2026-07-30, el tailnet tiene **un solo nodo**:

```
100.106.116.11  juanito  Manigreeen@  linux
tailscale serve → https://juanito.tail2df10b.ts.net (tailnet only) → 127.0.0.1:8080
```

O sea que el lado servidor está bien y lo que falta es sumar los dispositivos. En el Mac:

```bash
brew install --cask tailscale
```

Abrir la app, iniciar sesión con **la misma cuenta que ya tiene el nodo `juanito`** (la que aparece
como `Manigreeen@` arriba; si entras con otra identidad, creas un tailnet distinto y el nombre sigue
sin resolver). En el celular, la app de Tailscale con esa misma cuenta. Después de eso la URL abre
sola, sin abrir un puerto ni cambiar nada del VPS.

**Actualización 2026-07-30 — el tailnet ya tiene dos nodos.** El Mac entró:

```
100.106.116.11  juanito              Manigreeen@  linux
100.112.26.18   manuels-macbook-air  Manigreeen@  macOS
```

`https://juanito.tail2df10b.ts.net` **responde 200 desde el Mac** (~0.8s) y `/api/meta` devuelve el
sha desplegado, `deploy: true` y las 21 escrituras. O sea: el camino de red está cerrado de punta a
punta y la advertencia de `NXDOMAIN` ya no aplica en esa máquina.

## La primera mirada humana a la interfaz (2026-07-30) — dos bugs reales

El roadmap venía avisando que nadie había abierto la página. Se abrió, y en el primer minuto
aparecieron **dos defectos que ninguna verificación por `curl` podía encontrar**. Vale registrarlo
como evidencia de que "la API responde 200" no es lo mismo que "el dashboard funciona".

### Bug 1 — Toggles y Registries en pantalla negra

**Síntoma:** los otros 11 tabs abrían bien; esos dos dejaban la pantalla en negro.

**Causa, y no era de esos dos tabs.** `useEffect` corre DESPUÉS del commit. Al hacer click,
`setTab` re-renderiza de inmediato con el tab NUEVO y los `datos` del ANTERIOR; el `setDatos(null)`
del efecto llega tarde. O sea que `Contenido` recibía siempre, por un render, datos del tab
equivocado.

Los otros 11 tabs sobrevivían **de casualidad**: pasan por `<Tabla>`, que se defiende con
`!filas?.length` y pinta "Sin registros". Toggles y Registries son los únicos dos que desreferencian
directo — `datos.closers.length` y `datos.ignorados.map(...)` — así que tiraban `TypeError`.

**Arreglo estructural, no parche en los dos call sites:** los datos se guardan junto al tab al que
pertenecen (`{ tab, payload }`) y `Contenido` solo se dibuja cuando coinciden. De paso mata la
carrera de respuestas fuera de orden (ir a A → B → A rápido ya no deja que la respuesta lenta de B
se pinte encima de A). Poner `?.` en los dos lugares habría tapado el síntoma y dejado la trampa
armada para el próximo tab que alguien agregue.

### Y lo que convirtió un bug en un apagón: no había frontera de error

Una sola excepción de render desmontaba **la app entera** — root vacío, sin un mensaje. Eso es lo
contrario de la garantía 5 ("el dashboard degrada solo"): la consola sirve justamente cuando algo
anda mal, así que no puede ser lo primero que se cae.

Ahora hay una `FronteraDeError` con `key={tab}` que acota el daño AL TAB: muestra el stack y el
resto de la navegación sigue viva. **Probado rompiendo un tab a propósito:** la frontera atrapó, la
barra lateral siguió respondiendo, y volver a Salud se recuperó completo.

### Bug 2 — el tab Registries mentía sobre dry-run (el más grave de los dos)

Este no se veía como una falla: se veía como un dato.

`ACCOUNTS[x].token()`, `.dryRun()` y `.push4()` leen `process.env` **del proceso que llama**, y ese
proceso es el dashboard, no el bot. `docker-compose.yml` pasa las env explícitamente por servicio, y
a `dash` no le pasa ninguna de Calendly (no las necesita: nunca llama a la API). Resultado medido:

| | `.env` real | lo que ve el bot | lo que mostraba el dashboard |
|---|---|---|---|
| `CALENDLY_TOKEN` | presente | presente | **`tieneToken: no`** |
| `CALENDLY_TOKEN_RETIA` | presente | presente | **`tieneToken: no`** |
| `CALENDLY_DRY_RUN` | `false` | `false` | **`dryRun: sí`** |
| `CALENDLY_DRY_RUN_RETIA` | `false` | `false` | **`dryRun: sí`** |

O sea: el dashboard reportaba **MUDAS las dos conexiones que están enviando de verdad**, y sin token
un sistema que sí lo tiene. Es exactamente la clase de dato falso que este proyecto existe para
eliminar, ocurriendo adentro del proyecto.

**Arreglo:** los tres campos devuelven `null` y la tabla los pinta `—`, con un aviso en el tab
explicando por qué. Preferible un hueco honesto a un dato inventado. Verlos de verdad exige
preguntarle al proceso del bot, o sea el **control server de F6** — queda como una razón concreta
más para construirlo. Lo que no depende del entorno (`orgUri` con su default hardcodeado, `hubspot`,
`sheets`, `eventTypes`) sí es fiable y se sigue mostrando.

> 📌 De paso quedó medido que **`CALENDLY_DRY_RUN_RETIA=false`**: Retia ya NO está muda. Los
> comentarios de `accounts.js` todavía dicen "arranca MUDA hasta validar un ciclo completo". El
> código no está mal (el default sigue siendo `true`), pero el comentario describe un estado que ya
> no es el de producción.

**El selftest de lectura cazó el cambio solo:** su invariante era
`typeof c.tieneToken === 'boolean'` y `null` no lo es. Se actualizó a lo que de verdad importa
(`!== 'string'`, o sea que el token nunca viaje en el JSON), que es una guarda más precisa que la
anterior.

### Cómo mirar la interfaz localmente (contra datos reales)

Lo que hizo posible depurar esto sin tocar producción: `dashboard/vite.config.js` ya proxea `/api` a
`127.0.0.1:8080`, así que basta con dejar ahí algo que reenvíe al dashboard del tailnet, y correr el
frontend local con datos reales de producción y la consola del navegador abierta.

```bash
npm run dev --prefix dashboard
```

Con un proxy de ~15 líneas (`http.createServer` → `fetch('https://juanito.tail2df10b.ts.net' + req.url)`,
solo GET) en el 8080. Alternativa sin proxy: correr `node dashboard/server/index.js` local apuntando
`DB_PATH` a una copia de la base.

### Verificación del arreglo

- Los **13 tabs** renderizan (recorrido automatizado comprobando que el root no quede vacío).
- Frontera probada rompiendo un tab a propósito: atrapa, el resto sigue vivo, y se recupera al
  cambiar de tab.
- `selftest.js` (lectura) y `selftest-escrituras.js`: **verdes, exit 0**, contra una copia de
  producción.
- `npm run build`: compila.

### Desplegado y verificado en producción (2026-07-30) ✅

`785c2cf` con `alcance: dash`. `/api/meta` reporta el sha nuevo, `juanito-dash` se recreó y
**`juanito-agent` siguió `Up 22 hours` con el `StartedAt` intacto**.

Verificar el RENDER de lo desplegado tiene un truco, porque las herramientas de navegador están
bloqueadas contra `*.ts.net`: se levanta un espejo GET-only en localhost que reenvía **todo** (no
solo `/api`) al host del tailnet. Así el bundle que se inspecciona es el que de verdad está
sirviendo producción, no una compilación local.

Resultado: los **13 tabs** renderizan, y las dos conexiones muestran `tienetoken`/`dryrun`/`push4`
en `—` como corresponde (`hubspot` sigue en sí/no porque es constante de código, no del entorno).

**Lo que sigue pendiente:** sumar el celular al tailnet y mirarlo en pantalla chica. Y el pase de
diseño es F6.

## Cómo operar el dashboard

```bash
ssh root@157.230.152.202 'cd /root/juanito && docker compose up -d --no-deps --force-recreate dash'
```

```bash
ssh root@157.230.152.202 'docker logs --tail 50 juanito-dash'
```

- **Apagarlo sin afectar nada:** `docker compose stop dash`. El bot es indiferente.
- **Probar la capa de lectura contra datos reales, sin tocar la base viva:** copiar con
  `VACUUM INTO` a `/tmp` y correr `dashboard/server/selftest.js` con `DB_PATH` apuntando a la copia
  (el comando exacto está en la cabecera de ese archivo). Ojo: los dos selftests corren en
  **`juanito-dash`**, no en `juanito-agent` — el Dockerfile no mete `dashboard/` en la imagen y el
  bot no la bind-montea, así que `/app/dashboard` existe solo en el contenedor del dashboard. La
  cabecera de F1 decía `juanito-agent` y estaba mal; quedó corregida.
- **Probar la capa de ESCRITURA:** `dashboard/server/selftest-escrituras.js`, mismo patrón pero
  además con `DASH_WRITES=todo`. Hace round-trips completos (crear → modificar → cancelar), así que
  **solo corre sobre una copia**: tiene dos guardas que se niegan si `DB_PATH` huele a base viva.
- **Encender las escrituras de un tab:** `DASH_WRITES=aprobaciones` en el `.env` del VPS + recrear
  `dash`. Se acumulan por coma (`aprobaciones,toggles`) y `todo` habilita los ocho. Vacío = F1.
- **El `.env` del VPS es el único lugar donde importan `DASH_WRITES` y `DASH_GITHUB_TOKEN`.** No van
  al `.env` local del repo: ahí no corre el dashboard. Cada vez que se toca, hay que **recrear el
  contenedor** (`docker compose up -d --no-deps --force-recreate dash`) porque las env vars se leen
  al arrancar el proceso. Convención del VPS: `cp .env .env.bak-$(date +%Y%m%d-%H%M%S)-<motivo>`
  antes de editarlo.
- **Encender las alertas por WhatsApp:** `DASH_ALERTS_WHATSAPP=true` en el `.env` del VPS + recrear
  el contenedor. Arranca en `false` a propósito; ver la advertencia del §18.AV sobre el anti-ban.
- **Si Tailscale Serve falla:** poner `DASH_BIND` a la IP `100.x` del nodo y entrar por
  `http://<ip>:8080`. Sigue siendo solo-tailnet.
- **Ojo:** el código del dashboard se monta desde `/root/juanito/dashboard` del host, no está
  horneado en la imagen. Iterarlo NO requiere rebuild ni reinicia el bot.

---

## Por qué existe esto

Juanito funciona pero es intangible: vive en este repo y en un contenedor del VPS. Toda modificación
pasa por editar código y hacer deploy manual, y `/root/juanito` **no es un repo git** (se copia
archivo por archivo con `pscp`/`scp`), así que nadie sabe con certeza qué versión corre. La única
consola de operación son los comandos de WhatsApp, y la única observabilidad son `console.log` a
`docker logs` — que además se borran al recrear el contenedor.

El pendiente abierto del handoff lo resume: los dos últimos incidentes de pushes los descubrió **un
closer avisando**, no el sistema. Salazar estuvo una semana sin pre-call de Retia (§18.AV) y el dato
estaba en la DB desde el primer día.

**Tres objetivos:**

1. **Salud.** Ver logs de aviso, error y notificación, y enterarnos de una falla sin que la reporte
   quien usa la solución.
2. **Operación centralizada.** Todo lo que hoy son comandos de WhatsApp o literales en código
   (programas, empresas, closers, cuentas de Calendly), manejable desde un lugar organizado, con
   contratos claros para escalar.
3. **Jarvis.** Que se sienta un cerebro central y no un CRUD. Experiencia para los devs.

## Restricción dura

**Esto es una adición visual y de manejo. Juanito sigue funcionando.** Se debe poder pausar la
construcción en cualquier punto, hacer deploy, y continuar semanas después sin ninguna afectación.

### Las cinco garantías que lo hacen cierto

1. **Todo detrás de un interruptor con default = comportamiento de hoy.** Ver la tabla de
   interruptores más abajo.
2. **Migraciones solo aditivas, y `src/db/migrate.js` no se toca en fases tempranas.**
   `entrypoint.sh:11` es `node src/db/migrate.js && node src/index.js` → **una migración que falle
   deja al bot sin arrancar.** Es la línea más peligrosa del repo. El dash crea sus propias tablas en
   su propio proceso.
3. **Nada nuevo entra al proceso del bot hasta F6.** [src/index.js:297](../src/index.js) hace
   `process.exit(1)` ante cualquier excepción no capturada y `entrypoint.sh` duerme 30-300s. Un bug
   HTTP ahí dentro tumbaría WhatsApp hasta 5 minutos.
4. **Cada fase entrega read-only antes de escribir.** Primero ves el dato, después se habilita el
   botón que lo cambia, tab por tab.
5. **El dashboard degrada solo.** Si el bot está caído, los tabs que leen SQLite siguen funcionando.
   El dashboard sirve especialmente cuando el bot está mal.

---

## El descubrimiento que reordenó el plan

La primera versión de este plan tocaba 22 jobs, 71 call sites de `console.error`, `migrate.js` y
metía un servidor HTTP dentro del proceso del bot. Auditando qué era **indispensable**, resultó que
casi nada:

- **El dash puede importar `src/db/index.js` directamente.** Mismo repo, mismo volumen, WAL ya
  activo. Abre su propia conexión y hereda las ~122 funciones ya probadas e idempotentes. No hay que
  reimplementar nada ni exportar nada nuevo.
- **Y puede importar `src/calendly/{programs,accounts,closers}.js`**, que son JS puro sin deps
  nativas. El tab de programas/closers en modo lectura sale gratis, mostrando la verdad del código.
- **El watchdog no tiene que vivir en el bot.** La alerta más valiosa (el push que no sale) es una
  consulta SQL: `calendly_pushes WHERE status='scheduled' AND due_at < now-15min`.
- **Para mandar el DM de alerta, el dash usa la tabla `reminders` como outbox.** El cron de
  recordatorios corre cada minuto, está siempre encendido, y ya envía a `to_phone` por la cola
  anti-ban ([src/scheduler/reminders.js](../src/scheduler/reminders.js)). El dash inserta una fila con
  `saveReminder()` y el mensaje sale solo, sin socket y sin tocar el bot.

**Resultado:** los objetivos 1 y 2 se entregan **sin una línea de código nuevo dentro del proceso del
bot**. Todo lo que antes era la fase 1 pasó a ser opcional (F4-F6).

## Recon del VPS (medida 2026-07-30)

Antes de tocar nada se midió la deriva entre `/root/juanito` y `main`. Resultado:

- **Deriva real: CERO.** El `src/` de producción es idéntico a `main`. Un primer diff mostró 44
  archivos "distintos", pero era **puro CRLF**: los deploys históricos se hacían con `pscp` desde
  Windows. Con finales de línea normalizados no queda una sola diferencia de contenido.
  Para repetir la medición:
  ```bash
  sshpass -e ssh root@157.230.152.202 'cd /root/juanito && for f in $(find src scripts -type f | grep -v "/\._" | sort); do printf "%s  %s\n" "$(tr -d "\r" < "$f" | md5sum | cut -c1-32)" "$f"; done'
  ```
- **`/root/juanito` no es una copia limpia del repo**, es un directorio de trabajo acumulado: 30+
  `.env.bak-*`, 13 directorios `src.bak-*`, 7 `brain.sqlite.bak-*` (~2 MB c/u), 7
  `docker-compose.yml.bak-*`, scripts sueltos (`audit.js`, `audit2.js`, `audit3.js`, `members.js`,
  `check.mjs`, `retry-405.sh`, `watch-first-retia.sh`), `node_modules` instalado en el host, y sin
  `docs/` ni `test/`. **No se limpió nada** (sería destructivo y está fuera de alcance); queda
  anotado por si algún día se quiere ordenar.
- **7 archivos existen solo en el VPS y todos son muertos:** `closers.js.bak-20260721-152347`,
  `closers.js.bak-20260729-pre18AV`, `whatsapp/index.js.qrserver.bak`, `whatsapp/package.json` y
  `package-lock.json` (npm sueltos), y `src/stripe/{index,count}.js` del 5-jul que **nadie importa**
  (sobrantes de una iteración anterior del módulo de Stripe, reemplazada por `client.js` +
  `alerts.js`).
- **El remoto es privado y el VPS no tiene credenciales de GitHub** → de ahí el cambio de `git pull`
  a rsync (ver tabla de decisiones).
- `tailscale` no está instalado. Docker Compose es v5.1.4. Git 2.43.0 sí está.

## Hechos del entorno (medidos 2026-07-29)

```
Droplet: 1 vCPU · 1967 MB RAM · 2 GB swap · 33 GB libres · load 0.00 0.00 0.00
juanito-agent: 80.78 MiB RAM (4.1%) · 0.00% CPU
```

- **Servir el dashboard es gratis.** El bot usa 4% de la RAM y 0% de CPU. Dos devs mirando una página
  no pueden saturar nada.
- **El riesgo es *compilar*, no servir.** 1 vCPU. Hoy lo más pesado que pasa en la caja es
  `docker compose build` recompilando `better-sqlite3` con g++. Por eso el frontend se compila en
  GitHub Actions y al droplet solo llegan los estáticos.
- **El peligro serio no es saturación, es el crash domain.** De ahí el contenedor aparte.

---

## Decisiones tomadas

| Tema | Decisión | Alternativas descartadas y por qué |
|---|---|---|
| Audiencia | Solo los 2 devs. UI densa y técnica, jargon permitido | Incluir al jefe obligaría a una segunda vista con el lenguaje de `docs/ENTREVISTA-JEFE-JUANITO.md` (que prohíbe "cron", "endpoint", "LID"). Se puede sumar después |
| Exposición | **Tailscale.** Docker bindea a `127.0.0.1`, `tailscale serve` da HTTPS en un hostname `*.ts.net`. Gratis (plan Personal: 3 usuarios), sin comprar dominio, cero puertos públicos | **Cloudflare Tunnel + Access** también es gratis (tunnel ilimitado, Access hasta 50 usuarios) pero **necesita un dominio en Cloudflare**: sin él solo hay quick tunnels con URL que cambia en cada reinicio y sin Access. No mover el DNS de 30x.com por un dashboard interno. Es la opción a la que se sube si algún día entra alguien fuera del tailnet. **Caddy público** rompe la regla de no exponer puertos y obliga a escribir auth propia |
| Auth | Ninguna. En un tailnet de 2 personas la red ES la auth | Login propio = código de seguridad que mantener sin que aporte nada |
| Stack | **Vite + React** (SPA) + API con `node:http` | **Next.js** tiene el mismo techo estético (todo lo visual vive en el browser: Tailwind, Framer Motion, Canvas, WebGL, shadcn/ui), pero su runtime pesa 150-250 MB vs ~70 MB, y un dashboard tipo Jarvis es 100% cliente — RSC no compra nada cuando cada panel se actualiza solo. **Vercel** queda descartado: la data es un archivo SQLite en el droplet, así que un frontend en Vercel *igual* necesita un servicio en el VPS, y encima lo obliga a ser alcanzable desde internet público (una env var guarda la URL, no crea el camino de red). Solo compraría un servidor de build, que GitHub Actions da gratis sin partir el sistema en dos |
| Imagen Docker | El dash reusa **la misma imagen** del agent con otro `command:` | `better-sqlite3` ya está compilado y `src/` ya está dentro. Cero segundo Dockerfile, cero build extra |
| Frontend en disco | Bind mount `./dashboard/dist:/app/dashboard/dist:ro` | Así se actualiza el frontend sin rebuild de imagen y sin reiniciar `agent` |
| Deploys | **rsync desde el GitHub Action** de una lista explícita de rutas + archivo `DEPLOYED_SHA` + botón Deploy | **Cambiado el 2026-07-30 tras la recon.** El plan original era `git pull` en el VPS, pero **el repo es privado** y el droplet no tiene credenciales de GitHub (`git ls-remote` falla con "could not read Username"). Las alternativas eran una deploy key SSH o un PAT en `.git/config`; rsync gana porque **el VPS nunca necesita credenciales de GitHub** y la pregunta "¿qué versión corre?" la responde el `DEPLOYED_SHA` que escribe el pipeline. El rsync usa allowlist de rutas: nunca toca `.env`, `data/`, ni los backups acumulados |
| Botón Deploy | Dispara el workflow por la API de GitHub (`workflow_dispatch`) | **No** montar el socket de Docker en el dash: eso es root en el host. El pipeline es el único camino y GitHub queda como audit log |
| Alertas | DM de WhatsApp vía la tabla `reminders` como outbox + feed en el dashboard | El handoff advierte que las alertas compiten con el anti-ban y con la paciencia de quien las lee → **una alerta agregada al día**, y primero solo al dashboard hasta medir volumen |
| Jarvis | Estética con `/impeccable` + consola de chat con tools reales; confirmación explícita para lo que sale a un humano por WhatsApp | Sandbox total lo degrada a playground; sin confirmación, un prompt de prueba manda un mensaje real a un closer |

### Cómo se despliega hoy, y qué tiene de incómodo

Pregunta recurrente, así que queda escrita. **Ya no se copia el repo a mano.** Tampoco es un `git
pull`: `/root/juanito` **no es un repo git y no puede serlo**, porque el remoto es privado y el
droplet no tiene credenciales de GitHub (`git ls-remote` falla con "could not read Username").
Meterle una deploy key o un PAT sería darle al droplet acceso permanente al código.

Lo que hay es un **rsync de una allowlist de rutas desde GitHub Actions**: el runner ya tiene el
código checkouteado, compila el frontend y empuja `src/`, `scripts/`, `dashboard/`, `package*.json`,
`Dockerfile`, `docker-compose.yml` y `entrypoint.sh`. Nunca `.env`, `data/`, `node_modules/` ni los
`*.bak*`. Y escribe `DEPLOYED_SHA`, que responde la pregunta que antes no tenía respuesta: **qué
versión está corriendo**.

Lo que sí es incómodo, sin adornos:

- **El rsync de `src/` no lleva `--delete`.** Si un commit borra un archivo de `src/`, el archivo
  **sigue vivo en el VPS**. No hace daño mientras nadie lo importe, pero significa que el VPS es un
  superconjunto de `main`, no una copia. Los 7 archivos muertos que encontró la recon (incluidos
  `src/stripe/{index,count}.js` del 5-jul) son exactamente eso. La razón de no ponerlo es que
  `/root/juanito` acumula respaldos hechos a mano y borrarlos no es decisión de un pipeline; pero
  **acotar `--delete` a `src/` sí sería seguro** y está sobre la mesa.
- **No hay `git status` allá.** Para auditar deriva hay que comparar checksums (el comando está en
  "Recon del VPS"). Se midió el 2026-07-30 y dio cero.
- **`alcance: todo` reconstruye la imagen y reconecta Baileys.** Por eso el alcance es explícito y
  por eso un deploy de dashboard no puede tocar al bot ni por accidente.

Para lo que se necesitaba, alcanza y sobra: tres deploys esta sesión, 34-35s cada uno, y el bot no se
reinició ni una vez. La alternativa "de verdad" (repo git en el VPS) cuesta credenciales permanentes
en el droplet, que es peor negocio.

---

## Contrato: qué se toca de Juanito

### Indispensable (todo F1-F3 depende solo de esto)

| Cambio | Por qué | Impacto en el bot |
|---|---|---|
| `docker-compose.yml`: servicio `dash` | Es cómo corre el dashboard | Ninguno. `docker compose up -d dash` no recrea `agent` |
| `src/db/index.js`: una línea, `db.pragma('busy_timeout = 5000')` | Sin esto, un escritor concurrente recibe `SQLITE_BUSY` al instante en vez de esperar | Estrictamente protector: el bot espera en vez de fallar |
| `docs/`, `CLAUDE.md`, `.env.example` | Documentación | Ninguno |
| `.github/workflows/deploy.yml` (nuevo) | Deploys | Ninguno hasta que lo dispares |

**Una línea de código en `src/`.** Ese fue todo el costo de F1 y F2.

### Lo que F3a sumó al contrato (2026-07-30)

La tabla de arriba se escribió antes de construir F3. F3a resultó más barata que lo temido pero no
gratis, y esto es lo que de verdad toca:

| Cambio | Por qué | Impacto en el bot |
|---|---|---|
| `src/db/migrate.js`: 6 `CREATE TABLE IF NOT EXISTS` + llamada al seed | Es F3a | Aditivo. El seed va en `try/catch` con import dinámico y **está probado que un seed roto sale con exit 0** |
| `src/calendly/accounts.js`: bloque `env` declarativo por conexión | Una closure no es introspectable; el seed necesita el NOMBRE de la env var | Ninguno. Metadata pura, no la lee el runtime. Las closures quedaron intactas |
| `src/calendly/closers.js`: `export` de `PEOPLE` | El seed necesita la PERSONA; los mapas derivados son por identidad y ya la perdieron | Ninguno. Una palabra |
| `src/db/registry-seed.js`, `src/db/registry-read.js` (nuevos) | Seed y su reverso | Ninguno hasta F3c. Solo los llaman migrate.js y el test |

**Sigue sin entrar una línea al proceso del bot** en el sentido que importa: nada nuevo corre dentro
de `src/index.js` ni puede tirar una excepción en su crash domain.

### Anotado y diferido

Mejoras reales, ninguna necesaria para el dashboard. Se dejan escritas para no perderlas.

| Diferido | Qué compra | Por qué esperar |
|---|---|---|
| Borrar `COPY assets/ ./assets/` de [Dockerfile:25](../Dockerfile) | Que un build en máquina limpia funcione. **Hoy falla**: `assets/` no existe ni está en git, y `BROCHURE_FILES` ya no aparece en `src/` | En el VPS `assets/` existe creada a mano, así que los builds de allá sirven. Es una mina latente, no un bloqueo. Cuando toque un rebuild por otra razón, se borra en el mismo viaje. Ya estaba anotado en el handoff (§18.AG, nota final) |
| **`skip_reason` es columna muerta.** `markCalendlyPushSkipped` ([src/db/index.js:381](../src/db/index.js)) concatena la razón dentro de `message` y nunca escribe la columna. Medido: 194 de 195 filas `skipped` con `skip_reason` NULL | Poder hacer `GROUP BY skip_reason` en el tab de Salud, o sea ver que un motivo de skip pegó un salto esta semana | Es cambio en el camino de escritura del bot. **Muy barato y de alto valor** — es la pieza 2 del pendiente §18.AV. Sin esto, el panel de "motivos de skip" del tab Salud no se puede construir; el resto del tab sí. Candidato número uno a desdiferir |
| Alertar cuando un **host ignorado sigue agendando** (pieza 1 del §18.AV). `isIgnoredCloser()` hace `continue` sin log ni contador, lo que vuelve indistinguible un host retirado de uno que factura calls a diario | Habría cazado el incidente de Salazar el 22-jul en el primer poll | ~10 líneas en `src/scheduler/calendly.js`. El watchdog del dash puede detectar el síntoma por SQL (citas activas de hosts ignorados), así que no es bloqueante — pero la versión en el bot es más precisa |
| Envolver los 22 jobs en `runJob()` | Última corrida y duración por job | La alerta que de verdad importa se detecta por SQL sin instrumentar nada. Si algún día quieren el grid completo, se hace de a un job por vez. Es F4 |
| Shim `logEvent` en los ~71 `console.error` | Feed de errores completo en la UI | `docker logs` ya los tiene. Migrar 71 call sites en código vivo no se paga con lo que aporta |
| Costo de LLM de `src/claude/index.js` (~línea 2000) a una tabla | Costo agregado por día en vez de una línea de log por interacción | Métrica linda, cero urgencia |
| **Pushes huérfanos en `sending`.** Si el proceso muere entre `claimCalendlyPush` y `markCalendlyPushSent`, la fila queda en `sending` para siempre | Que un push reclamado y no enviado se reintente en vez de morir en silencio | Encontrado por el dashboard el 2026-07-30: **1 caso en toda la historia** (#898, 9-jul). No es urgente, pero es un modo de fallo real y hoy solo lo ve el dashboard. El arreglo (revertir a `scheduled` los `sending` viejos) va en `revertCalendlyPush`, que ya existe |
| Control server dentro del bot | `listGroups()` de grupos no autorizados, chat de Jarvis, `reload()` de registries | Es el único código que viviría en el crash domain del bot. Se posterga a F6 detrás de `CONTROL_PORT`, con el patrón de [qr-server.js:23](../src/whatsapp/qr-server.js) (`if (!port) return;`): sin la variable, no arranca |
| Tablas nuevas en `migrate.js` | — | Ver garantía 2. El dash crea sus tablas él mismo |

### Limitación honesta que este diseño acepta

Sin control server, el tab de Grupos **solo ve los grupos que ya están en `authorized_groups`**.
Autorizar un grupo nuevo se sigue haciendo con `/grupo on` por WhatsApp hasta F6. Es el único agujero
funcional del plan, y es a propósito: el precio de no meter código en el proceso del bot.

---

## Arquitectura

```
   Tailnet ──► https://juanito.<tailnet>.ts.net   (tailscale serve, en el host)
                          │
                          ▼
        ┌──────────────────────────────────────┐
        │ juanito-dash                         │  misma imagen, otro command
        │  node:http · 0 frameworks nuevos     │  mem_limit 256m · cpu_shares 512
        │   ├─ sirve dashboard/dist (bind ro)  │  bind 127.0.0.1 · sin `ports:`
        │   ├─ importa src/db/index.js         │
        │   ├─ importa src/calendly/*.js       │
        │   └─ watchdog + outbox vía reminders │
        └──────────────────┬───────────────────┘
                           │ volumen agent-data (WAL + busy_timeout)
                           ▼
        ┌──────────────────────────────────────┐
        │ juanito-agent — SIN CAMBIOS          │
        │  el cron de reminders (cada minuto,  │
        │  siempre on) despacha las alertas    │
        └──────────────────────────────────────┘
```

**Regla de división, una línea:** si necesita el socket de WhatsApp o memoria del proceso del bot, se
le pregunta al bot por el control server (F6). Si es puro dato, se lee/escribe SQLite directo.

La regla "no exponer puertos" se respeta al pie de la letra: ningún `ports:` publicado hacia
internet. Detalle y justificación en [ADR 0002](adr/0002-dashboard-y-superficie-http.md).

---

## Interruptores y sus defaults

Estado de cada flag. **Mantener esta tabla actualizada es parte del trabajo.**

| Interruptor | Default | Efecto del default | Fase |
|---|---|---|---|
| Servicio `dash` en compose | ausente | No hay dashboard | F1 |
| `DASH_BIND` | `127.0.0.1` | El puerto solo existe en loopback; se llega por `tailscale serve` | F1 |
| `DASH_ALERTS_WHATSAPP` | `false` | Watchdog solo escribe al dashboard, no manda DM | F1 |
| `DASH_GITHUB_TOKEN` | sin valor | `/api/deploy` no existe y la UI no dibuja el botón Deploy | F1 |
| ↳ *en producción hoy* | configurado | Botón Deploy activo (`deploy: true`) | F1 |
| `DASH_WRITES` | vacío | Dashboard read-only: ningún POST pasa, ningún botón se dibuja | F2 |
| ↳ *en producción hoy* | `todo` | Los 8 tabs escriben (21 acciones). Se apaga vaciando la variable | F2 |
| `REGISTRY_SOURCE_CONNECTIONS` | `code` | Lee de `accounts.js` como hoy | F3c |
| `REGISTRY_SOURCE_PROGRAMS` | `code` | Lee de `programs.js` como hoy | F3c |
| `REGISTRY_SOURCE_CLOSERS` | `code` | Lee de `closers.js` como hoy | F3c |
| filas en `job_config` | ninguna | Todos los jobs habilitados como hoy | F5 |
| `CONTROL_PORT` | sin valor | El control server nunca arranca; el bot es el de hoy | F6 |

### Kill switch por fase

| Fase | Cómo se revierte | ¿Toca al bot? |
|---|---|---|
| F1 GitHub Action | Deshabilitar el workflow en GitHub | No |
| F1 rsync de `dashboard/` | `docker compose stop dash`; el rsync nunca toca `src/` salvo que el commit lo cambie | No |
| F1 contenedor dash | `docker compose stop dash` | No |
| F1 alertas | `DASH_ALERTS_WHATSAPP=false` | No |
| F1 botón Deploy | Borrar `DASH_GITHUB_TOKEN` del `.env` | No |
| F2 escrituras | Sacar el tab de `DASH_WRITES` (o vaciarla) y recrear `dash` | No |
| F3 registries | `REGISTRY_SOURCE_*=code` | No |
| F4 `runJob` | El wrap es behavior-preserving; `git revert` job por job | No |
| F5 cron | Borrar las filas de `job_config` | No |
| F6 control server + chat | `CONTROL_PORT` sin valor | No |

---

## F1 — Dashboard read-only + alertas · cero cambios en el bot

- [x] **Tarea 0** — este archivo creado y referenciado desde `CLAUDE.md` y §18 del handoff.
- [x] **ADR 0002** — `docs/adr/0002-dashboard-y-superficie-http.md`.
- [x] **Medir la deriva VPS ↔ `main`** — hecha 2026-07-30, resultado cero. Ver "Recon del VPS".
      Reemplaza al plan original de convertir `/root/juanito` en repo git, que quedó descartado
      porque el remoto es privado y el droplet no tiene credenciales.
- [x] **Servicio `dash` en `docker-compose.yml`:** misma imagen que `agent` (`build: .`),
      `command: node dashboard/server/index.js`, bind-mount **de todo** `./dashboard:/app/dashboard:ro`
      (no solo `dist/`: así el código del server también llega sin rebuild de imagen y **sin tocar el
      Dockerfile ni reiniciar `agent`**), volumen `agent-data`, `mem_limit: 256m`, `cpu_shares` menor
      que el del bot, bind a `127.0.0.1`, **sin `ports:` públicos**. Levantar con
      `docker compose up -d dash` (solo ese servicio).
      Nota: el dash no necesita dependencias npm nuevas — `better-sqlite3` ya está en
      `/app/node_modules` de la imagen y `node:http` es builtin.
- [x] **`src/db/index.js`:** agregar `db.pragma('busy_timeout = 5000')` junto al `journal_mode = WAL`.
- [x] **Tailscale en el host** + `tailscale serve`. URL final:
      **`https://juanito.tail2df10b.ts.net`** (nodo `juanito`, IP `100.106.116.11`).
      Instalado desde el repo apt firmado, **no** con `curl | sh`.
      **Dos features del tailnet hay que habilitarlas en la consola** (no se puede desde el CLI):
      *Serve* (`login.tailscale.com/f/serve?node=…`) y *HTTPS Certificates* (Admin → DNS). Sin ellas,
      `tailscale serve` responde "Serve is not enabled on your tailnet" y `tailscale cert` da
      `your Tailscale account does not support getting TLS certs`.
      **Configuración final:** el contenedor escucha SOLO en loopback y `tailscaled` proxea con TLS.
      El puerto no está expuesto ni a internet ni al tailnet; solo el propio host lo alcanza.
      `DASH_BIND` en el `.env` del VPS queda como escape (apuntarlo a la IP `100.x` sirve sin Serve).
      Verificado desde afuera: **de todos los puertos del droplet, solo el 22 responde**; `curl` a
      `http://157.230.152.202:8080` da `HTTP 000`.
- [x] **`.github/workflows/deploy.yml`** con **solo `workflow_dispatch`** al principio. El trigger en
      push a `main` se habilita después, cuando el pipeline esté probado. Pasos: compilar el frontend
      → **rsync por SSH de una allowlist de rutas** → escribir `DEPLOYED_SHA` → reiniciar solo lo que
      cambió → publicar `logs --tail 50`. Secrets `VPS_HOST`, `VPS_PASSWORD`.
      **Allowlist:** `src/`, `scripts/`, `dashboard/`, `package.json`, `package-lock.json`,
      `Dockerfile`, `docker-compose.yml`, `entrypoint.sh`. **Nunca** `.env`, `data/`, `node_modules/`,
      ni los `*.bak*` del VPS. Sin `--delete` global, para no barrer los backups que el equipo dejó.
      ⚠️ **Anti-softban:** un deploy que solo toque `dashboard/` reinicia **únicamente** el
      contenedor `dash` — el bot ni se entera. Solo los cambios en `src/` o el `Dockerfile` obligan a
      reconstruir `agent`, y eso reconecta Baileys: unos pocos por hora, nunca en loop. El backoff de
      `entrypoint.sh` existe por un softban real.
      ✅ **Estrenado el 2026-07-30** con `gh workflow run deploy.yml -f alcance=dash`: 34-35s por
      corrida, y el bot NO se reinició (`StartedAt` idéntico antes y después, `Up 10 hours`).
      🐛 **La primera corrida destapó un bug de F1:** `/api/meta` seguía diciendo
      `sha: desconocido`. El workflow deja `DEPLOYED_SHA` en los dos lugares del host, pero el
      contenedor solo bind-montea `./dashboard:/app/dashboard`, así que `/app/DEPLOYED_SHA` **no
      existe adentro** — el archivo llega a `/app/dashboard/DEPLOYED_SHA`. Corregido; la segunda
      corrida ya reporta el sha real. Es exactamente la pregunta ("¿qué versión corre?") que este
      mecanismo existe para responder, así que valía el viaje.
- [ ] **Botón Deploy** en la UI → `POST /repos/Agencia-Dani/Juanito/actions/workflows/deploy.yml/dispatches`.
- [x] **API del dash** (`dashboard/api/`): importa `src/db/index.js` con `DB_PATH` apuntando al mismo
      archivo, e importa `src/calendly/{programs,accounts,closers}.js` para el tab de registries.
- [x] **Frontend** (`dashboard/`): Vite + React + Tailwind, devDependencies **aisladas** en
      `dashboard/package.json` (el `package.json` raíz tiene 0 devDependencies y una regla de "no
      agregar dependencias sin justificación clara").
- [x] **Tabs en modo lectura:** Salud · Aprobaciones · Respuestas · Grupos · Programados · Outreach ·
      Tareas · Negocio · Recordatorios · Calls · Registries · Toggles.
- [x] **Tab Salud** — 11 checks, todos derivados de SQL sobre datos que ya existen:
      `pushes_vencidos` (el push que no sale, §18.AV) · `pushes_atascados` en `sending` ·
      `pushes_no_entregados` por configuración · `respuestas_vencidas` · `outcomes_sin_respuesta` ·
      `reagendas_colgadas` · `recordatorios_fallidos` · `programados_sin_publicar` · `frescura` por
      tabla · `interruptores` · `motivos_skip`.
      **Dos correcciones sobre lo planeado, descubiertas al construirlo:**
      - *"Hosts ignorados con citas activas" NO es detectable desde la DB.* Un host en
        `IGNORED_CLOSERS` nunca genera fila de push, así que no deja rastro alguno — que es
        precisamente lo que hizo invisible al §18.AV. El dashboard hace lo único que puede sin tocar
        el bot: **mostrar la lista** en el tab Registries para que sea auditable, en vez de vivir
        enterrada en un archivo fuente. El detector real necesita la pieza 1 del §18.AV (en el bot).
      - *El breakdown de motivos de skip NO estaba bloqueado por el bug de `skip_reason`.* La razón
        se puede extraer del texto de `message`, donde `markCalendlyPushSkipped` la concatena. Es
        feo pero es solo lectura y da el panel hoy. El fix de la columna sigue siendo deseable.
- [x] **`pushes_no_entregados`**, el check que no estaba en el plan y resultó el más valioso:
      separa un skip legítimo (`cita canceled`, `rescheduled`, `push obsoleto`) de uno que significa
      **que un push no salió por falta de configuración** (`sin opt-in`, `sin hilo establecido`,
      `sin mapear`). Esa distinción es la familia entera del §18.AV.
      ⚠️ Al implementarlo apareció un falso positivo instructivo: probar el regex contra `message`
      completo marca filas sanas, porque ese campo guarda **también el copy de WhatsApp**, donde
      frases como "sin teléfono" aparecen legítimamente. Hay que probar contra el motivo extraído.
- [x] **Watchdog en el dash**, cada 15 min, dedupe en su propia tabla `dash_alerts`
      (`CREATE TABLE IF NOT EXISTS` en el arranque del dash, **no** en `migrate.js`).
      Arranca con `DASH_ALERTS_WHATSAPP=false`: solo escribe al dashboard. Tras medir volumen unos
      días, se enciende y entonces inserta con `saveReminder({ text, dueAt: ahora, toPhone: <admin> })`
      y el cron del bot lo despacha por la cola anti-ban.
      ⚠️ **Una alerta agregada al día**, no una por evento (advertencia explícita del handoff §18.AV:
      compite con el anti-ban y con la paciencia de quien la lee).
      🔍 **Verificar en implementación** qué prefijo le pone el job de recordatorios al texto, para
      que la alerta se lea bien y no como "Recordatorio: ...".

### Validación contra un incidente real (2026-07-30)

El check `pushes_no_entregados` se probó contra los datos de producción y encontró **8 pushes de
`daniela.camacho@30x.com` saltados por "closer sin opt-in"**, del 8 al 28 de julio. Diagnóstico:

- Su opt-in existe desde el 14-jul bajo el número `…4666` (`source=self`, con `contact_jid`).
- Pero los pushes se construían con `…2287`, el número **viejo** del roster.
- El roster se corrigió el 28-jul ([closers.js:51](../src/calendly/closers.js)) y **el último skip es
  del 28-jul 21:55**. O sea: es §18.AR (rotar un teléfono tiene dos pasos) y **ya está arreglado**.
  El check con ventana de 24h reporta 0, que es lo correcto.

**Lo que esto prueba:** de haber existido este dashboard el 8 de julio, habría marcado el primer
push saltado de Daniela **ese mismo día** en vez de que el problema viviera tres semanas. Es el
mismo patrón del §18.AV con Salazar. El check quedó validado contra historia real sin inventar una
alarma falsa.

**Otro hallazgo, este sin resolver:** el push **#898** (Push 3, Pablo Lozano, 9-jul) lleva desde
entonces en estado `sending`. Si el proceso muere entre `claimCalendlyPush` y `markCalendlyPushSent`,
la fila queda huérfana y **nadie la reintenta ni se entera**. Un solo caso en toda la historia, así
que no es urgente, pero es un modo de fallo real: anotado como diferido.

**Verificación de F1:**
- `docker inspect juanito-agent --format '{{.State.StartedAt}}'` sin cambios durante toda la fase.
- `npm test` verde (ojo: en Windows hay **64 tests rojos preexistentes**, comparar contra 64, no
  contra 0 — ver §18 "Visto de paso" del handoff).
- Provocar un push vencido en una **copia** de la DB y ver que el watchdog lo detecta.
- Con `DASH_ALERTS_WHATSAPP=true`, el DM llega al admin.
- ⏳ **PENDIENTE:** `https://juanito.<tailnet>.ts.net` abre desde el Mac y desde el celular. Sigue
  sin hacerse: el tailnet tiene un solo nodo (el VPS) y ninguna otra máquina entró todavía. Ver
  "Entrar al dashboard".

## F2 — Escrituras, tab por tab · cero cambios en el bot

Cada tab enciende sus escrituras por separado, reusando funciones ya exportadas en `src/db/index.js`.
**Escrito el 2026-07-30, apagado por default.** El interruptor es `DASH_WRITES`: una lista de tabs
por coma (o `todo`). Vacía = read-only. Encender un tab recrea `dash` y no toca al bot.

Piezas nuevas: [dashboard/server/actions.js](../dashboard/server/actions.js) (registro de acciones +
validación + el gate por tab), `POST /api/w/<tab>/<accion>` en el server,
[dashboard/src/Escrituras.jsx](../dashboard/src/Escrituras.jsx) en el frontend, y
[selftest-escrituras.js](../dashboard/server/selftest-escrituras.js).

- [x] Aprobaciones — `approveDraft`, `reviseDraft`, `discardDraft`, `approvePendingReply`,
      `revisePendingReply`, `discardPendingReply` (reemplaza `/aprobaciones` y `/respuestas`)
- [x] Grupos — `setGroupApproval`, `setGroupPersona`, `deleteGroupPersona` (`/persona`,
      `/confirmaciones`)
- [x] Programados — `createScheduledMessage`, `cancelScheduledMessage` (`/programados`)
- [x] Outreach — `finishOutreach` (`schedule_outreach`). **`createOutreach` NO se expone**, ver abajo
- [x] Tareas — `setTaskStatus` (`/tareas`), en dos acciones y no un `estado` genérico: **cerrar una
      tarea le avisa al que la pidió, descartarla no** (ver abajo)
- [x] Negocio — `setBusinessFactStatus` (`/negocio`)
- [x] Recordatorios — `saveReminder`, `cancelReminder`, `snoozeReminder` (`manage_reminders`)
- [x] Toggles — `setCalendlyPaused`, `setCloserPaused`, `setDmApproval` (`/calendly on|off`,
      `/confirmaciones dm`). Tab nuevo: en F1 los interruptores solo se veían dentro de Salud
- [x] **Desplegado** el 2026-07-30 con `alcance: dash` (dos corridas del workflow, ver §F1). El bot
      no se reinició: `StartedAt` siguió en `2026-07-30T00:30:02Z` y `docker ps` lo mostró `Up 10
      hours` en las dos. `/api/meta` responde `escrituras: {}` → read-only, como debe arrancar.
- [x] **Primer tab encendido: `toggles`** (2026-07-30). `DASH_WRITES=toggles` en el `.env` del VPS
      (con backup `.env.bak-*-pre-dashwrites`) + `docker compose up -d --no-deps --force-recreate
      dash`. Verificación end-to-end abajo.
- [x] **Los ocho tabs encendidos: `DASH_WRITES=todo`** (2026-07-30). Un detalle que se aclaró
      usándolo: **encender un tab no escribe nada por sí solo**. La bandera solo dibuja botones; el
      riesgo vive en el click, y las acciones que salen a un humano piden confirmación con
      destinatario y texto a la vista. Como las 21 acciones ya se ejercitaron contra una copia de
      producción, prender los siete restantes de una no era más riesgoso que prender uno.
      Verificado: `/api/meta` lista las 21 acciones sobre los 8 tabs, el log del dash las enumera, y
      el bot no se reinició (`StartedAt` en `2026-07-30T00:30:02Z` desde el principio de todo).
      Para volver atrás, `DASH_WRITES=` vacío o con menos tabs + recrear `dash`.

### Cuatro decisiones que se tomaron al construirlo

- **`createOutreach` NO se expone; solo cancelar.** Armar un outreach en el bot son ~80 líneas de
  reglas de negocio: resolver el contacto por nombre o número, validar el teléfono, respetar el piso
  anti-spam `OUTREACH_MIN_INTERVAL_MIN`, calcular la parada por default y el `next_due_at`, y
  resolver de parte de quién va el mensaje (§18.Y). Reimplementarlas en el dashboard las pone en dos
  lugares que van a divergir, y estos mensajes salen a **terceros que no son del equipo**. Crear
  sigue siendo por DM; apagar uno que se está portando mal es lo urgente y eso sí está.
  Es el mismo criterio que ya excluía a `deauthorizeGroup`.
- **Confirmación explícita para todo lo que termina en un WhatsApp real.** El servidor marca esas
  acciones con `sale: true` (aprobar un draft o una respuesta, crear un recurrente, crear un
  recordatorio) y las expone en `/api/meta`; la UI pide confirmación mostrando destinatario y texto.
  Es la regla que el roadmap fijaba para el chat de F6, aplicada desde ya.
- **Cerrar una tarea desde la UI avisa al solicitante, como lo hace `/tareas hecha`.** El comando
  manda un DM "✅ Listo lo que pediste" a `created_by` después de marcarla; `setTaskStatus` sola no
  lo hace. Sin replicarlo, una tarea cerrada desde el dashboard se cerraba **en silencio** para el
  jefe: el mismo agujero que este proyecto existe para tapar, del otro lado. El aviso sale por el
  outbox de `reminders` (el dash no tiene socket), así que llega prefijado:
  «⏰ Recordatorio: ✅ Listo lo que pediste: …». Se lee bien y no vale un cambio en el bot.
  `/negocio` en cambio **no** avisa a nadie, así que ahí no hay nada que replicar.
- **`cancelReminder`/`snoozeReminder` están scopeadas por `created_by`** para que por WhatsApp nadie
  toque los recordatorios de otra persona. El dashboard es consola de admin y le pasa el `created_by`
  de la propia fila, o sea que **sí** puede cancelar los de cualquiera: misma decisión que "en un
  tailnet de dos personas la red ES la auth". Las filas con `created_by` NULL no se pueden tocar
  desde acá y la UI lo dice en vez de fallar en silencio.

**`deauthorizeGroup` NO se expone.** En el bot va acompañado de `leaveGroup()` y el dash no tiene
socket; además volver a entrar a un grupo requiere que alguien invite al bot. Que salir de un grupo
siga siendo un acto deliberado por WhatsApp es lo correcto.

### Verificación de F2

Lo que se probó en el Mac (sin base nativa, ver la línea base de tests):

- Las 21 acciones rechazan un cuerpo vacío, y los casos límite de cada validador (día 7, hora
  `9:00`, `estado` inventado, sello de fecha sin segundos, `texto` y `brief` juntos, grupo no
  autorizado). El recorrido es sobre la tabla `ACCIONES` entera, así que una acción nueva sin
  validación aparece sola en el selftest.
- La capa HTTP: `POST` a un tab apagado → 400 con el mensaje del interruptor; JSON roto → 400;
  acción inexistente → 400; `PUT` → 405; `/api/deploy` sin token → 400. `/api/meta` publica el
  catálogo de escrituras y `deploy: false`.
- `npm run build` del frontend compila.

Y en el contenedor, sobre una copia de la base de producción (2026-07-30, **todo verde, exit 0**):

```bash
docker exec -e DB_PATH=/tmp/copia.sqlite -e DASH_WRITES=todo juanito-dash node /app/dashboard/server/selftest-escrituras.js
```

Los round-trips que corrieron contra datos reales: toggles global de Calendly y de aprobación de DMs
(cambia y se restaura), pausa por identidad de un closer, recordatorio crear → posponer → cancelar →
cancelar-otra-vez-avisa, mensaje recurrente crear → verificar `days`/`time_hm` → cancelar →
cancelar-otra-vez-no-aplica, default-deny de un grupo no autorizado, y persona de grupo poner → leer
de vuelta → borrar. **La base viva quedó intacta**, verificado después: `calendly_paused=0`, 0
recordatorios pendientes, 2 mensajes recurrentes activos (los que había). La copia se borró.

#### End-to-end del tab Toggles, en producción (2026-07-30) ✅

Lo que había que probar era que una escritura del dashboard se vea igual desde el bot. Se probó
**sin cambiar el comportamiento de Juanito**, con dos trucos que conviene reusar:

1. **Se pausó un email centinela que no existe en el roster**
   (`dashboard-selftest@30x.invalid`). `setCloserPaused` solo escribe
   `settings['calendly_pause:<email>']`, así que la fila recorre exactamente el mismo camino que la
   de un closer real, pero **ninguna cita puede tener ese host** → cero efecto operativo. Pausar a
   un closer de verdad, aunque fuera por segundos, arriesga que un push que caiga en esa ventana se
   marque `skipped` y se pierda: es literalmente el modo de fallo del §18.AV.
2. **`/calendly` se renderizó con el código del bot, sin mandar un WhatsApp.** `buildCalendlyStatus`
   es una función pura de `isCalendlyPaused` + `listCloserPauses` + `resolveCloser`, y
   `src/bot/commands.js` no importa DB ni WhatsApp al tope (es testeable sin deps nativas). Así que
   `handleCommand({ text: '/calendly', role: 'admin' }, deps)` dentro de `juanito-agent` imprime el
   texto EXACTO que el comando manda por WhatsApp, sin enviar nada:

```bash
docker exec juanito-agent node --input-type=module -e 'import { isCalendlyPaused, listCloserPauses } from "/app/src/db/index.js"; import { resolveCloser } from "/app/src/calendly/closers.js"; import { handleCommand } from "/app/src/bot/commands.js"; console.log(await handleCommand({ text: "/calendly", sender: "check", role: "admin" }, { isCalendlyPaused, listCloserPauses, resolveCloser }));'
```

Resultado: `Closers pausados: ninguno` → POST al dashboard →
`Closers pausados: dashboard-selftest@30x.invalid` → POST de reversa → `ninguno`. El bot no se
reinició (`StartedAt` intacto, `Up 20 hours`) y las dos escrituras quedaron en el log del dash.
**Único rastro:** la fila `calendly_pause:dashboard-selftest@30x.invalid = 0`, invisible en todas
las vistas (`listCloserPauses()` solo devuelve las que valen `1`, y el tab Toggles itera el roster).

Lo que sigue faltando, y necesita encender más tabs: aprobar un draft desde la UI y confirmar que el
cron de `group-messages` lo publica.

> 📌 **Observado de paso:** `dm_approval = 1` en producción, o sea la **aprobación de DMs de
> desconocidos está ENCENDIDA**. No lo tocó esta sesión; queda anotado porque ahora se ve de un
> vistazo en el tab Toggles y nadie lo había mirado.

## F3 — Registries editables (opcional, la parte cara)

La **lectura** ya llegó en F1 importando los módulos. Esto es solo la escritura, y es la fase más
invasiva: toca el módulo más testeado del repo (~60 archivos de test, ~840 casos) y la invariante de
[ADR 0001](adr/0001-modelo-empresa-programa-closer.md): **el copy precall debe quedar byte-idéntico.**

- [x] **3a — Tablas + seed, nadie lee.** ✅ **2026-07-30.** `companies`, `connections`, `programs`,
      `closers`, `closer_identities`, `ignored_closers` en [migrate.js](../src/db/migrate.js) §3,
      sembradas desde los literales por [registry-seed.js](../src/db/registry-seed.js) **solo si
      están vacías**. El runtime sigue leyendo del código.
      Sembrado real: **3 empresas · 2 conexiones · 7 programas · 8 personas · 10 identidades ·
      12 ignorados**. (El plan decía "13 ignorados": era el conteo de antes de que
      `equipo@ttrading.co` saliera de `IGNORED_CLOSERS` el 29-jul por el §18.AV. Son 12.)
- [x] **3b — Test de equivalencia.** ✅ **2026-07-30** —
      [test/data.registry.test.js](../test/data.registry.test.js), **16 tests verdes** en el
      contenedor. Además del round-trip compara el ORDEN de los programas, y fija tres invariantes
      que hasta ahora solo vivían en comentarios: un teléfono = una persona, toda identidad apunta a
      una conexión/empresa que existe, y **ningún closer del roster está además en ignorados** (el
      §18.AV exacto).
      **Compara las estructuras CRUDAS, no `buildPrecallText()`.** Los mapas de copy
      (`PROGRAM_PITCH`, `MATERIAL_LINKS`, `PROGRAM_LABELS`) son proyecciones puras de `PROGRAMS`: si
      el insumo es idéntico, el copy es byte-idéntico por construcción, y encima quedan cubiertos
      los programas que hoy no tienen ni una cita agendada. Re-derivarlos en el test habría dado una
      segunda copia de esa lógica destinada a divergir. Los tres derivados se comprueban igual, por
      redundancia barata.
      [registry-read.js](../src/db/registry-read.js) es el reverso del seed y es lo que F3c reusa.

#### Cinco cosas que se decidieron construyéndolo

1. **`accounts.js` guardaba comportamiento, no datos.** `token: () => process.env.CALENDLY_TOKEN` no
   es introspectable: desde afuera no hay forma de saber que la variable se llama `CALENDLY_TOKEN`,
   y el seed necesita ese nombre. Se le agregó un bloque `env` declarativo por conexión.
   **Convive con las closures en vez de reemplazarlas**, a propósito: reescribir `dryRun` es tocar
   el camino por el que salen (o no salen) los pushes, y F3a se declaró riesgo cero. La red contra
   la deriva entre ambas representaciones es un test que las ejercita con la env prendida, apagada y
   ausente. F3c, que ya tiene que recablear esto, las colapsa.
2. **No hay secretos en la base.** De cada conexión se guarda el NOMBRE de su env var, nunca el
   token. La DB se copia a `/tmp` en cada selftest; un token adentro se filtraría en cada copia.
3. **`sort_order` no es cosmético.** Los literales son objetos y el código itera en orden de
   inserción: `programFromTitle` devuelve el PRIMER programa cuyo hint matchea. Sin preservar el
   orden, un título ambiguo se clasifica a otro programa → otro pitch. El test lo fija.
4. **El seed solo llena tablas VACÍAS y nunca actualiza.** Es lo que hace posible F3d: el código es
   la SEMILLA, no el dueño permanente del dato. Un test comprueba que una edición hecha a mano
   sobrevive a la siguiente corrida.
5. **El seed no puede dejar al bot sin arrancar, y está probado, no afirmado.** `entrypoint.sh` es
   `node src/db/migrate.js && node src/index.js` — la línea más peligrosa del repo (garantía 2). El
   seed va en `try/catch` con **`await import` dinámico y no un import estático**: un import estático
   que falle revienta al CARGAR el módulo, antes de que el `try` exista. Se rompió el seed a
   propósito de las dos maneras (error de sintaxis y excepción en runtime) contra una copia de
   producción: las dos veces gritó en el log y **salió con exit 0**. Como en F3a nadie lee esas
   tablas, un seed fallido no tiene ninguna consecuencia operativa; tumbar WhatsApp por él sería el
   peor negocio posible. ⚠️ Cuando F3c encienda la lectura, este try/catch deja de alcanzar por sí
   solo: la garantía pasa a ser el flag `REGISTRY_SOURCE_*` + este test.

#### Verificación de F3a+F3b (2026-07-30)

Todo contra el contenedor del VPS, con `src/` y `test/` montados desde `/root/dash-verify` — el
código nuevo **nunca entró a producción**.

| Qué | Resultado |
|---|---|
| `test/data.registry.test.js` en el contenedor | **16 pass · 0 fail** |
| `test/data.*.test.js` en el contenedor | **77 pass · 2 fail** (los 2 son los preexistentes de `data.scheduled-calls`; antes era 61/2 de 63) |
| Suite local, Mac | `pass` **idéntico a HEAD (742)**; +16 tests y +16 rojos, que son el archivo nuevo sin binding nativo |
| Migración contra copia de producción (`VACUUM INTO`) | Siembra limpia, y la **segunda corrida no imprime nada** → idempotente |
| Seed roto (sintaxis y excepción) | `exit 0` las dos veces |
| Base VIVA tras todo | **0 tablas de registries** — nada tocó producción |
| `docker inspect juanito-agent` | `StartedAt` sigue en `2026-07-30T00:30:02Z` |

> ⚠️ **La línea base de tests del Mac que dice "127 rojos" no se reproduce.** Medida en la misma
> sesión, `HEAD` da **805 tests · 742 pass · 63 fail**. Los 742 verdes sí coinciden, así que ese es
> el número contra el que conviene comparar; el de rojos depende de qué tan completo esté el
> `node_modules` de la raíz y no sirve de referencia estable.
- [ ] **3c — Lectura desde DB detrás de flag, un registry a la vez.** Los módulos conservan
      **exactamente su API pública**, así que los ~60 tests siguen importando lo mismo; solo cambia de
      dónde salen los datos. Los derivados (hoy computados al importar) pasan a un cache invalidado
      por escritura, con un `reload()` exportado.
      Orden obligatorio, con tests verdes entre cada paso: `connections` → `programs` → `closers`.
      **Pausar aquí = dejar los flags en `code`.**
- [ ] **3d — Escritura desde la UI**, registry por registry, solo después de que el flag lleve días en
      `db` sin incidentes. Botón "Ver mensaje exacto" que renderiza el copy antes de guardar,
      reusando lo que ya hace [scripts/calendly-precall-preview.js](../scripts/calendly-precall-preview.js).
      Primer cambio real con `CALENDLY_DRY_RUN=true`.

### Cómo desplegar F3a (y por qué conviene NO desplegarla sola)

F3a toca `src/` (`migrate.js`, `accounts.js`, `closers.js` + dos módulos nuevos), así que su deploy
es `alcance: todo`: **reconstruye la imagen y reconecta Baileys**. Y lo que compra ese viaje es que
existan seis tablas **que nadie lee**.

**Recomendación: no desplegarla sola.** Que viaje de arriba de la próxima corrida de `alcance: todo`
que haga falta por otra razón — o de F3c, que es cuando las tablas empiezan a servir para algo. El
backoff de `entrypoint.sh` existe por un softban real; gastar una reconexión en código inerte es
justo el tipo de riesgo que este roadmap se propuso no correr.

Cuando toque, las tablas se crean solas al arrancar (`migrate.js` corre antes que `index.js`) y el
seed las llena en esa misma corrida. No hay paso manual.

⚠️ Probar la migración contra una copia de la DB de producción antes de deployear. Lo hecho el
2026-07-30 (sin tocar la base viva: `VACUUM INTO` a una copia, y la copia borrada después):
⚠️ **Ojo con el comando obvio.** `docker exec juanito-agent … node src/db/migrate.js` corre el
`src/` **de la imagen**, o sea el código VIEJO: probaría la migración que ya está desplegada, no la
nueva. Hay que montar el código a probar, igual que los tests:

```bash
sshpass -e rsync -a --delete -e ssh src/ root@157.230.152.202:/root/dash-verify/src/
```

```bash
docker exec juanito-agent node --input-type=module -e 'import D from "better-sqlite3"; new D("/app/data/brain.sqlite",{readonly:true}).exec("VACUUM INTO '"'"'/tmp/copia.sqlite'"'"'")' && docker cp juanito-agent:/tmp/copia.sqlite /root/dash-verify/copia.sqlite && docker exec juanito-agent rm -f /tmp/copia.sqlite
```

```bash
docker run --rm -v /root/dash-verify/src:/app/src:ro -v /root/dash-verify/copia.sqlite:/tmp/copia.sqlite -e DB_PATH=/tmp/copia.sqlite --entrypoint node juanito-agent:latest src/db/migrate.js
```

Correrlo **dos veces**: la segunda no debe imprimir ninguna línea de seed. Borrar la copia al final.

📎 Contexto obligatorio antes de tocar closers: el handoff §18.AR ("rotar el teléfono de un closer
tiene DOS pasos y el segundo no lo hace nadie") y §18.AV (el cupo de Retia de Salazar vivía en un
correo que nunca existió). La UI de closers debería hacer imposible ese par de errores.

## F4 — Telemetría de jobs (opcional)

Primer cambio real en el código del bot, y solo si quieren el grid completo de jobs.

- [ ] `src/scheduler/run-job.js` → `runJob(name, fn)`: mide duración, escribe `job_runs`, captura el
      error. **Behavior-preserving:** llama a `fn()` y propaga exactamente igual que hoy; la escritura
      de telemetría va en su propio `try/catch` para que un fallo de logging jamás mate un job.
- [ ] Envolver **de a un job**, empezando por los 3 de Calendly (poll, deliver, outcome) que son los
      que ya causaron incidentes. Pausar a mitad deja unos instrumentados y otros no, sin consecuencia.
- [ ] Los 19 restantes, cuando y si hace falta.

## F5 — Control de cron (opcional, depende de F4)

- [ ] Tabla `job_config(job, enabled, cron, updated_at)`. **Fila ausente = habilitado**, así que una
      tabla vacía es exactamente el comportamiento de hoy.
- [ ] **On/off en caliente:** `runJob()` chequea `isJobEnabled(name)` y si está off retorna sin
      ejecutar. ~10 líneas, cero manejo de ciclo de vida de `CronJob`. Eso es lo que hace que no sea
      delicado.
- [ ] **Cambiar horario:** se escribe en DB; el arranque lee con precedencia `job_config.cron` → env
      → default, y la UI dice "aplica al reiniciar". **No** recrear `CronJob` en caliente: que un cron
      string malo deje un job muerto en silencio no vale el ahorro. Validar con `new CronTime(str)`
      antes de guardar.

Nota: hoy los jobs se habilitan por **env var + presencia de credencial**, con dos convenciones que
se confunden fácil: `=== 'true'` (default OFF) y `!== 'false'` (default ON). La UI debe mostrar cuál
aplica a cada job para no invertir un flag por accidente.

## F6 — Jarvis

- [ ] **Estética** con `/impeccable`: paleta, tipografía, layout, animaciones, motion. Cero cambios en
      el bot. La estética se decide en esa sesión, no en este documento.
- [ ] **Control server** (`src/control/server.js`): **no arranca sin `CONTROL_PORT`**, mismo patrón
      que [qr-server.js:23](../src/whatsapp/qr-server.js). `try/catch` por request + handler `'error'`
      en el server para que nada escape al crash domain. Escucha solo en la red interna de compose,
      sin `ports:`. Desbloquea `isConnected()`, `listGroups()`, `sendQueue.size()`, `getHealth()` y el
      chat.
- [ ] **Autorizar grupos desde la UI** (cierra la limitación honesta de arriba).
- [ ] **Consola de chat:** → `src/claude/index.js` con `role='admin'` y thread `dash:<userId>`,
      aislado de los threads de WhatsApp igual que hoy los grupos se aíslan por `chat_id`.
- [ ] **Tools reales con confirmación selectiva:** las de lectura y datos internos ejecutan directo;
      las que envían algo a un humano por WhatsApp vuelven como `tool_use` pendiente, la UI muestra
      destinatario y texto exactos, y el click confirma.

---

## Notas de implementación

- **Dependencias:** el backend del dash es `node:http` + `better-sqlite3` (ya en el repo, cero
  frameworks nuevos). Vite/React/Tailwind entran **solo** como devDependencies de
  `dashboard/package.json`.
- **El dash crea sus propias tablas** (`dash_alerts` y lo que necesite) con
  `CREATE TABLE IF NOT EXISTS` en su arranque. `migrate.js` no se toca hasta F3a.
- **Cada env var nueva va a `docker-compose.yml` explícitamente** o no llega al contenedor (gotcha
  documentado en [src/calendly/accounts.js:18](../src/calendly/accounts.js)), y a `.env.example`, que
  `CLAUDE.md` declara fuente de verdad. Ojo: hoy hay **15 vars en compose que faltan en
  `.env.example`**, incluida `ADMIN_LID` — vale corregirlo de paso.
- **La imagen no incluye `test/`.** Correr la suite dentro del contenedor devuelve vacío y parece
  verde. Para verificar ahí, importar módulos y comprobar valores.
- **Recrear el contenedor borra su historial de `docker logs`.** Razón adicional para que la
  observabilidad viva en la DB y no en los logs.

## Verificación end-to-end

Al cierre de cada fase:

```bash
npm test
```

```bash
sshpass -e ssh root@157.230.152.202 'cd /root/juanito && docker compose run --rm agent node --test "test/data.*.test.js"'
```

### Línea base de tests (medida 2026-07-30)

Al medir regresiones hay que comparar contra estos números, **no contra cero** (misma advertencia
que el handoff hace sobre los 64 rojos de Windows):

| Dónde | Resultado | Nota |
|---|---|---|
| Mac, Node 26, `node --test "test/*.test.js"` | **742 verdes · 127 rojos** | Los 127 son la capa nativa: `better-sqlite3` no tiene binding para Node 26. Idéntico antes y después del cambio de `busy_timeout`. Ojo: el `node_modules` de la raíz puede estar incompleto (faltaban `pdfkit` y `docx`) y eso hace que el runner muera sin imprimir resumen — correr `npm install` primero |
| Contenedor, `test/data.*.test.js` | **61 pass · 2 fail** de 63 | Los 2 rojos son **preexistentes**, verificado corriendo el mismo contenedor contra el `src` de HEAD: `call con TODOS sus pushes skipped … sale de la agenda` y `reagenda manual superseded no se cuenta dos veces` (ambos en `data.scheduled-calls.test.js`) |

Para correr la capa nativa contra código local sin tocar producción:
```bash
docker run --rm -v /root/dash-verify/src:/app/src:ro -v /root/dash-verify/test:/app/test:ro -e TZ=America/Bogota --entrypoint node juanito-agent:latest --test "test/data.*.test.js"
```

- `docker inspect juanito-agent --format '{{.State.StartedAt}}'` → confirma que el bot no reinició.
- `docker stats --no-stream` → el bot en ~80 MB, el dash por debajo de su `mem_limit`.
- [`docs/SMOKE-TEST.md`](SMOKE-TEST.md) (bloques A-E) antes de cerrar cualquier fase que sí toque el
  bot (F4-F6).
- Abrir `https://juanito.<tailnet>.ts.net` desde el Mac y desde el celular.

## Preguntas abiertas

- ~~¿Qué prefijo le pone el job de recordatorios al texto?~~ **Respondida:**
  [src/scheduler/reminders.js:24](../src/scheduler/reminders.js) manda
  `⏰ Recordatorio: ${text}`, hardcodeado. Por eso las alertas del watchdog empiezan con 🚨 y el
  aviso de tarea cerrada con ✅: el prefijo se asume, no se pelea.
- ¿Se desdifiere el fix de `skip_reason` para desbloquear el panel de motivos de skip? Es el
  candidato número uno: una línea, alto valor, ya es pendiente aceptado del repo (§18.AV pieza 2).
- ¿El jefe entra algún día? Si sí, la exposición sube de Tailscale a Cloudflare Access y hace falta
  una segunda vista con el lenguaje de `docs/ENTREVISTA-JEFE-JUANITO.md`.
