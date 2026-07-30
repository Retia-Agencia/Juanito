# Dashboard centralizado de Juanito — Roadmap

> **Estado:** planeado, sin ejecutar. Última actualización: 2026-07-29.
> **Fuente de verdad de este proyecto.** Si retomas en otra sesión, lee este archivo completo antes
> de tocar nada. Decisión arquitectónica formal en [ADR 0002](adr/0002-dashboard-y-superficie-http.md).

## Cómo retomar en frío

1. Lee este archivo entero (son ~15 min y te ahorran repetir la discusión).
2. `git log --oneline -10` y revisa qué casillas de abajo están marcadas.
3. Revisa la tabla **Interruptores y sus defaults** para saber en qué estado quedó el sistema.
4. Sigue por la primera casilla sin marcar. Las fases son independientes y pausables.

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
| Deploys | `/root/juanito` → repo git *in situ* + GitHub Action + botón Deploy | Clonar a un directorio nuevo exigiría parar el contenedor (mismo `container_name`). *In situ* con `git init` + `reset --mixed` no modifica un solo archivo |
| Botón Deploy | Dispara el workflow por la API de GitHub (`workflow_dispatch`) | **No** montar el socket de Docker en el dash: eso es root en el host. El pipeline es el único camino y GitHub queda como audit log |
| Alertas | DM de WhatsApp vía la tabla `reminders` como outbox + feed en el dashboard | El handoff advierte que las alertas compiten con el anti-ban y con la paciencia de quien las lee → **una alerta agregada al día**, y primero solo al dashboard hasta medir volumen |
| Jarvis | Estética con `/impeccable` + consola de chat con tools reales; confirmación explícita para lo que sale a un humano por WhatsApp | Sandbox total lo degrada a playground; sin confirmación, un prompt de prueba manda un mensaje real a un closer |

---

## Contrato: qué se toca de Juanito

### Indispensable (todo F1-F3 depende solo de esto)

| Cambio | Por qué | Impacto en el bot |
|---|---|---|
| `docker-compose.yml`: servicio `dash` | Es cómo corre el dashboard | Ninguno. `docker compose up -d dash` no recrea `agent` |
| `src/db/index.js`: una línea, `db.pragma('busy_timeout = 5000')` | Sin esto, un escritor concurrente recibe `SQLITE_BUSY` al instante en vez de esperar | Estrictamente protector: el bot espera en vez de fallar |
| `docs/`, `CLAUDE.md`, `.env.example` | Documentación | Ninguno |
| `.github/workflows/deploy.yml` (nuevo) | Deploys | Ninguno hasta que lo dispares |

**Una línea de código en `src/`.** Eso es todo el costo de F1-F3.

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
| `DASH_ALERTS_WHATSAPP` | `false` | Watchdog solo escribe al dashboard, no manda DM | F1 |
| Escrituras por tab (config del dash) | todas off | Dashboard read-only | F2 |
| `REGISTRY_SOURCE_CONNECTIONS` | `code` | Lee de `accounts.js` como hoy | F3c |
| `REGISTRY_SOURCE_PROGRAMS` | `code` | Lee de `programs.js` como hoy | F3c |
| `REGISTRY_SOURCE_CLOSERS` | `code` | Lee de `closers.js` como hoy | F3c |
| filas en `job_config` | ninguna | Todos los jobs habilitados como hoy | F5 |
| `CONTROL_PORT` | sin valor | El control server nunca arranca; el bot es el de hoy | F6 |

### Kill switch por fase

| Fase | Cómo se revierte | ¿Toca al bot? |
|---|---|---|
| F1 git in situ | `rm -rf /root/juanito/.git` | No, ni un archivo se modifica |
| F1 GitHub Action | Deshabilitar el workflow en GitHub | No |
| F1 contenedor dash | `docker compose stop dash` | No |
| F1 alertas | `DASH_ALERTS_WHATSAPP=false` | No |
| F2 escrituras | Apagar por tab; read-only por default | No |
| F3 registries | `REGISTRY_SOURCE_*=code` | No |
| F4 `runJob` | El wrap es behavior-preserving; `git revert` job por job | No |
| F5 cron | Borrar las filas de `job_config` | No |
| F6 control server + chat | `CONTROL_PORT` sin valor | No |

---

## F1 — Dashboard read-only + alertas · cero cambios en el bot

- [ ] **Tarea 0** — este archivo creado y referenciado desde `CLAUDE.md` y §18 del handoff.
- [ ] **ADR 0002** — `docs/adr/0002-dashboard-y-superficie-http.md`.
- [ ] **`/root/juanito` → repo git *in situ*, sin reiniciar nada:**
      ```bash
      cd /root/juanito && git init && git remote add origin https://github.com/Agencia-Dani/Juanito.git && git fetch origin && git reset --mixed origin/main
      ```
      No modifica un solo archivo del working tree. `git status` después muestra exactamente en qué
      difiere el VPS de `main` — información que hoy no existe. **Revisar ese diff antes de seguir.**
      El `.env` está en `.gitignore`, nunca corre riesgo. `assets/` aparecerá como untracked: dejarla.
- [ ] **Servicio `dash` en `docker-compose.yml`:** misma imagen que `agent` (`build: .`),
      `command:` distinto, `./dashboard/dist:/app/dashboard/dist:ro`, volumen `agent-data`,
      `mem_limit: 256m`, `cpu_shares` menor que el del bot, bind a `127.0.0.1`, **sin `ports:`
      públicos**. Levantar con `docker compose up -d dash` (solo ese servicio).
- [ ] **`src/db/index.js`:** agregar `db.pragma('busy_timeout = 5000')` junto al `journal_mode = WAL`.
- [ ] **Tailscale en el host** + `tailscale serve https / http://127.0.0.1:8080`.
- [ ] **`.github/workflows/deploy.yml`** con **solo `workflow_dispatch`** al principio. El trigger en
      push a `main` se habilita después, cuando el pipeline esté probado. Pasos: compilar el frontend
      → SSH → `git pull` → `docker compose up -d` → publicar `logs --tail 50`. Secrets `VPS_HOST`,
      `VPS_PASSWORD`.
      ⚠️ **Anti-softban:** cada deploy que reconstruya `agent` reconecta Baileys. Unos pocos por
      hora, nunca en loop. El backoff de `entrypoint.sh` existe por un softban real.
- [ ] **Botón Deploy** en la UI → `POST /repos/Agencia-Dani/Juanito/actions/workflows/deploy.yml/dispatches`.
- [ ] **API del dash** (`dashboard/api/`): importa `src/db/index.js` con `DB_PATH` apuntando al mismo
      archivo, e importa `src/calendly/{programs,accounts,closers}.js` para el tab de registries.
- [ ] **Frontend** (`dashboard/`): Vite + React + Tailwind, devDependencies **aisladas** en
      `dashboard/package.json` (el `package.json` raíz tiene 0 devDependencies y una regla de "no
      agregar dependencias sin justificación clara").
- [ ] **Tabs en modo lectura:** Salud · Aprobaciones · Respuestas · Grupos · Programados · Outreach ·
      Tareas · Negocio · Recordatorios · Calls · Registries · Toggles.
- [ ] **Tab Salud**, todo derivado de SQL sobre datos que ya existen:
      - `calendly_pushes` vencidos sin enviar ← **el push que no sale, §18.AV**
      - `pending_replies` pendientes por encima del TTL, y las `held` por quiet hours
      - `call_outcomes` sin responder y `awaiting_date` estancados
      - `scheduled_drafts` pendientes que no se van a publicar
      - frescura por tabla (último `created_at` de `messages`, `calendly_pushes`, `call_outcomes`)
      - opt-ins sembrados vs. ganados (`source='self'`), closers pausados
      - hosts en `IGNORED_CLOSERS` con citas activas ← síntoma del §18.AV
      - *(bloqueado hasta desdiferir el fix de `skip_reason`)* breakdown de motivos de skip
- [ ] **Watchdog en el dash**, cada 15 min, dedupe en su propia tabla `dash_alerts`
      (`CREATE TABLE IF NOT EXISTS` en el arranque del dash, **no** en `migrate.js`).
      Arranca con `DASH_ALERTS_WHATSAPP=false`: solo escribe al dashboard. Tras medir volumen unos
      días, se enciende y entonces inserta con `saveReminder({ text, dueAt: ahora, toPhone: <admin> })`
      y el cron del bot lo despacha por la cola anti-ban.
      ⚠️ **Una alerta agregada al día**, no una por evento (advertencia explícita del handoff §18.AV:
      compite con el anti-ban y con la paciencia de quien la lee).
      🔍 **Verificar en implementación** qué prefijo le pone el job de recordatorios al texto, para
      que la alerta se lea bien y no como "Recordatorio: ...".

**Verificación de F1:**
- `docker inspect juanito-agent --format '{{.State.StartedAt}}'` sin cambios durante toda la fase.
- `npm test` verde (ojo: en Windows hay **64 tests rojos preexistentes**, comparar contra 64, no
  contra 0 — ver §18 "Visto de paso" del handoff).
- Provocar un push vencido en una **copia** de la DB y ver que el watchdog lo detecta.
- Con `DASH_ALERTS_WHATSAPP=true`, el DM llega al admin.
- `https://juanito.<tailnet>.ts.net` abre desde el Mac y desde el celular.

## F2 — Escrituras, tab por tab · cero cambios en el bot

Cada tab enciende sus escrituras por separado, reusando funciones ya exportadas en `src/db/index.js`.

- [ ] Aprobaciones — `approveDraft`, `reviseDraft`, `discardDraft`, `approvePendingReply`,
      `revisePendingReply`, `discardPendingReply` (reemplaza `/aprobaciones` y `/respuestas`)
- [ ] Grupos — `setGroupApproval`, `setGroupPersona`, `deleteGroupPersona` (`/persona`,
      `/confirmaciones`)
- [ ] Programados — `createScheduledMessage`, `cancelScheduledMessage` (`/programados`)
- [ ] Outreach — `createOutreach`, `finishOutreach` (`schedule_outreach`)
- [ ] Tareas — `setTaskStatus` (`/tareas`)
- [ ] Negocio — `setBusinessFactStatus` (`/negocio`)
- [ ] Recordatorios — `saveReminder`, `cancelReminder`, `snoozeReminder` (`manage_reminders`)
- [ ] Toggles — `setCalendlyPaused`, `setCloserPaused`, `setDmApproval` (`/calendly on|off`,
      `/confirmaciones dm`)

**`deauthorizeGroup` NO se expone.** En el bot va acompañado de `leaveGroup()` y el dash no tiene
socket; además volver a entrar a un grupo requiere que alguien invite al bot. Que salir de un grupo
siga siendo un acto deliberado por WhatsApp es lo correcto.

**Verificación:** aprobar un draft desde la UI y confirmar que el cron de `group-messages` lo
publica. Pausar un closer desde la UI y verlo reflejado en `/calendly` por WhatsApp (misma fuente de
verdad, `settings.calendly_pause:<email>`).

## F3 — Registries editables (opcional, la parte cara)

La **lectura** ya llegó en F1 importando los módulos. Esto es solo la escritura, y es la fase más
invasiva: toca el módulo más testeado del repo (~60 archivos de test, ~840 casos) y la invariante de
[ADR 0001](adr/0001-modelo-empresa-programa-closer.md): **el copy precall debe quedar byte-idéntico.**

- [ ] **3a — Tablas + seed, nadie lee.** `programs`, `companies`, `connections`, `closers`,
      `closer_identities`, `ignored_closers`, sembradas desde los literales actuales (7 programas, 2
      conexiones, 8 personas con sus identidades, 13 ignorados) **solo si están vacías**. El runtime
      sigue leyendo del código. Riesgo: cero.
- [ ] **3b — Test de equivalencia.** Compara `buildPrecallText()` y todos los derivados
      (`eventTypeToProgram`, `PROGRAM_LABELS`, `PROGRAM_PITCH`, `MATERIAL_LINKS`, `CLOSERS`,
      `CLOSER_LIDS`, `HUBSPOT_OWNER_TO_CLOSER`, `resolveCloser*`) entre seed-en-DB y literales. Si no
      es idéntico, el seed está mal. Nada lee de DB todavía.
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

⚠️ Esta es la única fase que necesita tocar `migrate.js`, y solo en 3a. Probar la migración contra una
copia de la DB de producción antes de deployear:
```bash
docker exec juanito-agent sh -c 'cp /app/data/brain.sqlite /tmp/t.sqlite && DB_PATH=/tmp/t.sqlite node src/db/migrate.js'
```

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

- `docker inspect juanito-agent --format '{{.State.StartedAt}}'` → confirma que el bot no reinició.
- `docker stats --no-stream` → el bot en ~80 MB, el dash por debajo de su `mem_limit`.
- [`docs/SMOKE-TEST.md`](SMOKE-TEST.md) (bloques A-E) antes de cerrar cualquier fase que sí toque el
  bot (F4-F6).
- Abrir `https://juanito.<tailnet>.ts.net` desde el Mac y desde el celular.

## Preguntas abiertas

- ¿Qué prefijo le pone el job de recordatorios al texto? Define si el outbox por `reminders` se lee
  bien o hay que ajustar el copy de las alertas.
- ¿Se desdifiere el fix de `skip_reason` para desbloquear el panel de motivos de skip? Es el
  candidato número uno: una línea, alto valor, ya es pendiente aceptado del repo (§18.AV pieza 2).
- ¿El jefe entra algún día? Si sí, la exposición sube de Tailscale a Cloudflare Access y hace falta
  una segunda vista con el lenguaje de `docs/ENTREVISTA-JEFE-JUANITO.md`.
