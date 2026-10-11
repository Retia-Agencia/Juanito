# Links cortos — contrato de acceso y operación (Cloudflare)

> Estado al 2026-10-10: **diseñado, no construido.** Este archivo es el contrato: dice dónde está
> cada credencial, quién tiene acceso y cómo se opera. Quien construya la feature lo completa
> (marcado `⏳`) y nadie la prende hasta que esté completo. Decisión de arquitectura en
> [ADR 0004](adr/0004-links-cortos-en-cloudflare.md); análisis en
> [LINKS-CORTOS-PLAN.md](LINKS-CORTOS-PLAN.md).

## Principio: nada depende de una sola persona ni de un solo computador

El VPS ya funciona así: la contraseña está en el `.env` local de quien trabaja en el repo y el
deploy corre desde GitHub Actions. Cloudflare sigue el mismo modelo:

- **Todo el código y la config no secreta viven en el repo.** Ningún cambio se hace a mano en el
  panel de Cloudflare. Si se hizo, se pasa al repo o se deshace.
- **Todo deploy corre en GitHub Actions**, nunca desde un computador. Cualquiera con permiso de
  `Actions` en `Retia-Agencia/Juanito` puede desplegar, revisar o volver atrás.
- **Cada persona entra a Cloudflare con su propio usuario.** No hay contraseña compartida.

## Quién tiene acceso

| Qué | Dónde | Quién |
|---|---|---|
| Cuenta de Cloudflare | Cuenta de la empresa (correo de rol, no personal) ⏳ | Mani y Alejo como **Administrator**, cada uno con su login y 2FA |
| Código del Worker y esquema de D1 | `infra/shortlinks/` en este repo ⏳ | Todo el que tenga el repo |
| Deploy, health check y rollback | Workflow `.github/workflows/shortlinks.yml` ⏳ | Todo el que pueda correr Actions |
| Interruptor por conexión | Tabla `settings` del bot, comando `/linkscortos` ⏳ | Admins de Juanito (DM) |

Si alguien sale del equipo: se le quita el usuario en Cloudflare y se rotan los dos secretos de
abajo. Nada más depende de él.

## Credenciales (inventario completo)

Ninguna va al repo. Los nombres sí, para que cualquiera sepa qué buscar.

| Nombre | Para qué | Dónde vive | Permisos |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Desplegar el Worker y migrar D1 | Secreto de GitHub Actions del repo · `.env` local (como `VPS_KEY`) para diagnosticar | Account: Workers Scripts **Edit**, D1 **Edit**. Nada más |
| `CLOUDFLARE_ACCOUNT_ID` | Identifica la cuenta | `infra/shortlinks/wrangler.toml` (no es secreto) ⏳ | — |
| `SHORTLINKS_SECRET` | El bot lo manda al crear links | Secreto de GitHub · secreto del Worker (lo pone el workflow) · `/root/juanito/.env` del VPS | Solo sirve para crear links en `POST /api/links` |
| `SHORTLINKS_URL` | Base de los links (`https://<worker>.workers.dev`) | `/root/juanito/.env` y `.env.example` | — |

Rotar `SHORTLINKS_SECRET`: se cambia en GitHub, se corre el workflow (actualiza el Worker) y se
cambia en el `.env` del VPS. Mientras tanto, el bot cae solo al link largo: no se pierde ningún
push.

## Operación

### ¿Está funcionando?

1. **Health check:** workflow `shortlinks.yml` con `accion: health` ⏳. Pide `GET /health` y un
   link canario fijo, y confirma que devuelve `302` a `https://wa.me/`. Desde una terminal:
   `curl -sI https://<worker>.workers.dev/l/<canario>`.
2. **Watchdog del dash:** hace lo mismo cada pocos minutos y alerta por WhatsApp (tabla
   `reminders`) si falla ⏳.
3. **Bot:** cada caída al link largo queda en `docker logs juanito-agent` con la etiqueta
   `[LinksCortos]` ⏳. Si aparecen muchas, el bot no está pudiendo crear links.

### Se cayó: qué hacer

1. **Primero, que los closers no sufran:** `/linkscortos off <conexión>` en el DM de Juanito. Los
   pushes siguientes salen con el link largo, sin reiniciar nada. Los links ya enviados siguen
   dependiendo del Worker.
2. Logs del Worker: panel de Cloudflare → Workers → `shortlinks` → Logs, o
   `npx wrangler tail shortlinks` con el token del `.env`.
3. Si fue un deploy: workflow `shortlinks.yml` con `accion: rollback` ⏳ (`wrangler rollback`
   vuelve a la versión anterior).
4. Arreglar en el repo, desplegar con el workflow, `/linkscortos on <conexión>` y anotar el
   incidente en §18 del handoff.

### Desplegar un cambio

PR o commit a `main` → workflow `shortlinks.yml` con `accion: deploy` ⏳. El workflow aplica las
migraciones de D1 (idempotentes) antes de publicar el Worker. El deploy del Worker **no toca el
VPS ni reconecta WhatsApp**: es independiente del `deploy.yml` del bot.

### Revisar datos

`npx wrangler d1 execute shortlinks --remote --command "<sql>"` con el token del `.env`. La tabla
guarda teléfonos y texto de leads: consultar solo lo necesario y no copiar filas fuera.

## Extender a 30X (u otra empresa)

Hoy califican solo los programas con `company: 'retia'` en `src/calendly/programs.js`, y eso está
fijado en el código a propósito (ADR 0004): ningún comando puede prender 30X por error. Para
sumarla:

1. Ampliar la regla de empresa en el código. Es un cambio de una línea, pero va con sus tests.
2. Agregar los golden tests de los pushes de 30X con el interruptor prendido y apagado.
3. Enmendar el ADR 0004 (sección "Solo Retia") con la fecha y la razón.
4. Desplegar el bot y seguir el mismo rollout: modo sombra → un closer piloto → el resto.
   `/linkscortos on 30x` solo después del piloto.

No hace falta tocar Cloudflare: el Worker no sabe de empresas y el volumen de 30X cabe en el plan
gratis de D1 (100.000 escrituras al día contra ~300 de todo Juanito hoy).
