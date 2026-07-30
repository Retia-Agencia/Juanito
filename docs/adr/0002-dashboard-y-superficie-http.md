# Dashboard centralizado: la primera superficie HTTP del sistema

## Status

accepted (2026-07-29) — diseño grillado; ejecución pendiente. Roadmap y tareas en
[docs/DASHBOARD-ROADMAP.md](../DASHBOARD-ROADMAP.md).

## Contexto

Juanito solo se puede operar por comandos de WhatsApp y solo se puede modificar editando código y
desplegando a mano. `/root/juanito` no es un repo git (se copia archivo por archivo), así que la
versión que corre en producción es una incógnita. La observabilidad son `console.log` a `docker
logs`, que se borran al recrear el contenedor. Consecuencia medida: los dos últimos incidentes de
pushes los descubrió un closer avisando, no el sistema — Salazar estuvo una semana sin pre-call de
Retia (§18.AV) con el dato en la DB desde el primer día.

La restricción que manda sobre todo: **el dashboard es una adición; Juanito sigue funcionando**. Se
debe poder pausar la construcción en cualquier punto, desplegar, y continuar semanas después sin
afectación.

Y hay una regla previa que colisiona de frente: **"no exponer puertos en docker-compose"**, escrita en
`CLAUDE.md`, repetida en `docker-compose.yml:8-9`, citada en `src/scheduler/stripe-alerts.js:4` como
razón para hacer poll a Stripe en vez de webhook, y usada en el handoff (§11, ~línea 1502) para
rechazar los webhooks de Calendly. No es incidental: nace de un softban real de WhatsApp.

## Decisión

- **El dashboard va en un contenedor aparte, no dentro del proceso del bot.** La razón no es
  saturación (el droplet está en 1 vCPU / 1967 MB con el bot en 80 MB y load 0.00) sino el **crash
  domain**: `src/index.js:297` hace `process.exit(1)` ante cualquier excepción no capturada y
  `entrypoint.sh` duerme 30-300s antes de revivir. Un bug en un handler HTTP dentro del bot tumbaría
  WhatsApp hasta 5 minutos. El aislamiento cuesta ~70 MB y se hace contractual con `mem_limit: 256m`
  y `cpu_shares` menor que el del bot.
- **La regla de no exponer puertos se conserva literalmente.** Ningún `ports:` publicado hacia
  internet. El dash bindea a `127.0.0.1` y se alcanza por **Tailscale** (`tailscale serve` da HTTPS en
  un hostname `*.ts.net`, gratis y sin comprar dominio). El control server de F6 escucha solo en la
  red interna de compose. Lo que la regla protege —que el proceso que sostiene el socket de Baileys no
  reciba tráfico entrante desde internet— se sigue cumpliendo.
- **El dashboard reusa el código existente en vez de reimplementarlo.** Importa
  `src/db/index.js` (mismo archivo SQLite, WAL ya activo, ~122 funciones probadas e idempotentes) y
  `src/calendly/{programs,accounts,closers}.js` (JS puro, sin deps nativas). No se exporta nada nuevo
  ni se duplica lógica de dominio.
- **Las alertas de WhatsApp salen por la tabla `reminders` como outbox.** El cron de recordatorios
  corre cada minuto, está siempre encendido y ya despacha a `to_phone` por la cola anti-ban. El dash
  inserta con `saveReminder()` y el mensaje sale. Así se cumple la regla "todo envío sale del proceso
  principal y pasa por la cola anti-ban" **sin darle un socket al dashboard y sin tocar el bot**.
- **Nada nuevo entra al proceso del bot hasta la última fase**, y cuando entra va detrás de
  `CONTROL_PORT` con el patrón de `src/whatsapp/qr-server.js:23` (`if (!port) return;`): sin la
  variable, el bot es byte por byte el de hoy.
- **`src/db/migrate.js` no se toca en fases tempranas.** `entrypoint.sh:11` es
  `node src/db/migrate.js && node src/index.js`: una migración que falle deja al bot sin arrancar. El
  dash crea sus propias tablas con `CREATE TABLE IF NOT EXISTS` en su propio proceso.
- **Alcance mínimo indispensable = una línea de código en `src/`**: `db.pragma('busy_timeout = 5000')`
  en `src/db/index.js`, porque hoy un segundo escritor recibe `SQLITE_BUSY` al instante en vez de
  esperar. Todo lo demás son archivos nuevos y `docker-compose.yml`.

## Consecuencias

- **Sin control server, el tab de Grupos solo ve `authorized_groups`.** Los grupos donde el bot está
  pero no autorizado requieren `listGroups()` de Baileys. Autorizar un grupo nuevo se sigue haciendo
  con `/grupo on` por WhatsApp hasta la fase 6. Es el único agujero funcional y es deliberado: el
  precio de no meter código en el proceso del bot.
- **`deauthorizeGroup` no se expone en el dashboard.** En el bot va acompañado de `leaveGroup()`, y el
  dash no tiene socket; además volver a entrar exige que alguien invite al bot. Sacar al bot de un
  grupo queda como acto deliberado por WhatsApp.
- **Dos procesos escriben el mismo SQLite.** WAL lo soporta y el volumen real es de decenas de filas
  por hora, pero no hay coordinación transaccional entre procesos ni `PRAGMA foreign_keys`. El
  `busy_timeout` convierte la contención en espera en vez de error. Si algún día el volumen crece,
  la salida es enrutar las escrituras por el control server (escritor único), no meter locks.
- **Migrar los registries de código a DB queda detrás de flags por registry con default `code`.** Los
  módulos conservan su API pública exacta, así que los ~60 archivos de test siguen importando lo
  mismo. La invariante de [ADR 0001](0001-modelo-empresa-programa-closer.md) —copy precall
  byte-idéntico— se protege con un test de equivalencia seed-en-DB vs. literales, y con un preview del
  mensaje exacto en la UI antes de guardar. Pausar = dejar los flags en `code`.
- **El despliegue es rsync desde CI, no `git pull` en el VPS.** El repo es privado y el droplet no
  tiene credenciales de GitHub; las opciones eran una deploy key SSH, un PAT en `.git/config`, o que
  el workflow —que ya tiene el código checkouteado— empuje una allowlist de rutas por SSH. Gana la
  tercera: **el VPS nunca necesita credenciales de GitHub**, y la pregunta "¿qué versión corre?" la
  responde un archivo `DEPLOYED_SHA` que escribe el pipeline. Consecuencia aceptada: `/root/juanito`
  sigue sin ser un repo git, así que no hay `git status` para inspección manual — la deriva se mide
  con un diff de checksums desde el Mac (procedimiento en el roadmap). Medida el 2026-07-30: cero.
- **El código del dashboard se monta, no se hornea en la imagen.** `./dashboard:/app/dashboard:ro`
  evita tocar el `Dockerfile` y evita reconstruir la imagen compartida, con lo cual desplegar una
  iteración del dashboard **no reinicia el bot**. El precio es que el contenedor `dash` depende de
  archivos del host; a cambio, el aislamiento que exige la restricción del proyecto se cumple sin
  excepciones.
- **Cada deploy que reconstruya `agent` reconecta Baileys.** El botón de Deploy hace del despliegue
  algo trivial de disparar, lo cual es justo el riesgo que el softban enseñó. Queda documentado el
  límite: unos pocos por hora, nunca en loop. Y el botón dispara el workflow de GitHub por API, no
  monta el socket de Docker en el contenedor (eso sería root en el host).
- **Las alertas compiten con el anti-ban y con la paciencia de quien las lee** (advertencia explícita
  del pendiente §18.AV). El watchdog arranca sin mandar WhatsApp (`DASH_ALERTS_WHATSAPP=false`, solo
  dashboard) y se enciende tras medir volumen unos días, con preferencia por **una alerta agregada al
  día** sobre una por evento.
