# Links cortos de los pushes en Cloudflare (Worker + D1), solo para Retia

## Status

accepted (2026-10-10). Análisis completo en [docs/LINKS-CORTOS-PLAN.md](../LINKS-CORTOS-PLAN.md).
Ejecución pendiente. Enmienda el [ADR 0002](0002-dashboard-y-superficie-http.md) en un solo punto
(ver Decisión).

## Contexto

Cada lead de un push lleva un link `https://wa.me/<tel>?text=<mensaje codificado>` de 1.100 a
1.500 caracteres. Medido el 2026-10-08: el 78% de lo que Juanito les manda a los closers son links,
y el mensaje más largo pesó 20.259 caracteres. El 2026-10-09 un paréntesis sin codificar partió
todos los links del push del viernes de Andrea. Ese bug ya está corregido en `buildLeadLink`, pero
muestra que un link de mil caracteres tiene mil oportunidades de romperse.

Un link corto necesita un servicio público que reciba el clic y redirija al wa.me guardado. Público,
porque los closers no están en el tailnet. Eso choca con el ADR 0002, que no permite tráfico de
internet hacia el VPS. El motivo de esa regla sigue vigente: la IP fija del VPS es la que usa
WhatsApp, y el proceso que sostiene el socket de Baileys no puede quedar expuesto.

Restricciones de Mani (2026-10-10):

- **Juanito no puede fallar.** Un push sin link, o con un link que no abre, es peor que un mensaje
  largo.
- **Solo los programas de Retia.** Los de 30X y EstadoX no se tocan.
- **Nada corre en el computador de Mani.** Ni procesos permanentes ni deploys manuales desde ahí.
- Cómo se vea el link da igual. Que sea corto y que no falle.

Volumen medido: ~273 links distintos por día hábil, con ~300 proyectados en el pico de 141 citas.
Retia es una fracción de eso.

## Decisión

### Dónde vive

**Un Cloudflare Worker con una base D1**, en una cuenta de Cloudflare a nombre de 30X/Retia (no
personal). El dominio es el gratuito `*.workers.dev`.

- **D1 y no KV.** KV es de consistencia eventual: un link recién guardado puede tardar hasta 60 s o
  más en verse desde otra región, y un closer que toca apenas le llega el push se encontraría con
  un 404. D1 tiene un primario único: lo que se escribe se lee enseguida. El plan gratis permite
  100.000 filas escritas por día, ~300 veces lo que usaríamos (KV gratis: 1.000).
- **Fuera del VPS**, lo que deja el ADR 0002 intacto en lo que protege: no entra tráfico de
  internet al servidor de WhatsApp. La enmienda es una sola: el bot pasa a hacer una llamada HTTPS
  saliente más, igual a las que ya hace a HubSpot, Calendly y Sheets.
- Si el VPS se cae, los links ya enviados siguen funcionando.

### Cómo escribe el bot

- El Worker expone `POST /api/links`, protegido con un secreto compartido. Recibe la lista de
  wa.me de un mensaje y devuelve un id por cada uno. **El VPS no guarda un token de la API de
  Cloudflare**, solo ese secreto, que no sirve para otra cosa que crear links.
- El Worker solo acepta destinos que empiecen por `https://wa.me/` y solo redirige a lo que tiene
  guardado. Nunca lee el destino de la URL, así que no se puede usar como open redirect.
- Una sola llamada por mensaje (un digest de 17 leads = 1 llamada), con `fetchConDeadline` y un
  timeout corto.

### Cómo no falla (en orden de importancia)

1. **Todo o nada por mensaje, con caída al link largo.** Si la llamada falla, se pasa del tiempo o
   devuelve algo raro, el mensaje entero sale con los links largos de siempre. Nunca un push sin
   link ni un mensaje con links mezclados. El link largo es el plan de respaldo permanente, no
   código que se borra.
2. **Solo Retia, decidido en el código.** Califica para link corto un lead cuyo programa tenga
   `company: 'retia'` en `programs.js` (Tactical Investor, Comunicarte y PowerTalk). Se decide
   **por lead**, no por mensaje: un digest con programas de dos empresas acorta solo los de Retia.
   Un comando no puede prender 30X por error, porque el código ni siquiera lo considera.
3. **Interruptor por conexión, en la DB y apagado por defecto.** Vive en `settings` y se mueve con
   un comando de admin (mismo patrón que `/espejo`). Apagarlo no reinicia el contenedor, así que no
   reconecta Baileys.
4. **Apagado = byte por byte igual a hoy.** Los builders siguen puros y reciben una función
   `linkFor` que por defecto es `buildLeadLink`. Los tests golden (que se escriben antes de tocar
   nada) fijan el texto exacto de cada push con el interruptor apagado, y fijan que los mensajes de
   30X y EstadoX no cambian aunque Retia esté prendido.
5. **El redirector no está en el proceso del bot.** Un bug en el Worker no tumba WhatsApp.
6. **Vigilancia.** El watchdog del dash consulta cada pocos minutos un link de prueba fijo y alerta
   por `reminders` si no responde con el 302 esperado. El bot deja en el log cada caída al link
   largo.

### Vida del link

Vence 7 días después de la hora de la llamada. Un link vencido o inexistente devuelve la misma
página (no se puede distinguir uno del otro). Un cron del propio Worker borra las filas vencidas.
El id es aleatorio de 8 caracteres base62 (~47 bits): no se adivina.

### Despliegue: nada en el computador de Mani

El código del Worker vive en este repo (`infra/shortlinks/`). Se despliega con un workflow de
GitHub Actions (`workflow_dispatch`, como `deploy.yml`) que corre `wrangler deploy` con un token
de Cloudflare guardado como secreto de GitHub. El secreto compartido llega al `.env` del VPS por el
mismo camino del deploy. Lo único manual es crear la cuenta de Cloudflare y su token, porque eso
exige iniciar sesión.

### Rollout

1. Desplegar el Worker y el código del bot con todo apagado. Los golden tests prueban que no cambió
   nada.
2. Prueba en aparatos (Android, iPhone y WhatsApp Web) con un link real del Worker, antes de prender
   nada para un closer.
3. Modo sombra en `retia`: acuña el link corto y lo registra, pero manda el largo. Mide errores y
   latencia sin tocar a nadie.
4. Piloto: Andrea en `retia`. Una semana sin incidentes.
5. `comunicarte` y `powertalk`, una conexión a la vez.

## Consecuencias

- **Aparece un modo de falla que antes no existía:** si el Worker se cae después de enviado el
  push, el closer toca el link y no pasa nada. Lo cubren el watchdog y el plan gratis de Cloudflare,
  que es independiente del VPS. No lo elimina.
- Teléfono y texto de cada lead de Retia quedan en una cuenta de Cloudflare propia, con vencimiento
  a los 7 días. Hoy esos datos ya viajan en claro en el link largo. Lo nuevo es que quedan
  guardados afuera mientras el link esté vivo.
- Una cuenta más que operar (Cloudflare) y dos secretos más (token de deploy en GitHub, secreto
  compartido en el VPS).
- Si 30X quiere links cortos más adelante, es un cambio deliberado en el código (ampliar la regla
  de empresa), no un comando. A propósito.
- Costo: 0 USD con el volumen actual.

## Alternativas descartadas

- **Tailscale Funnel en el VPS:** gratis y los datos no salen, pero los links mueren con el VPS, y
  Funnel abre un puerto entero. En :443 publicaría el dash, así que tendría que ir en :8443.
  Además mete tráfico de internet al servidor de WhatsApp.
- **Cloudflare Tunnel o puerto abierto en el VPS:** el mismo problema de tráfico entrante. El
  puerto abierto además expone la IP de WhatsApp.
- **Cloudflare Worker + KV:** la consistencia eventual rompe el caso "el closer toca apenas le
  llega".
- **Vercel + Upstash:** técnicamente equivalente, pero el plan Hobby no permite uso comercial (Pro
  cuesta ~20 USD/mes).
- **Supabase:** el plan gratis se pausa tras días sin uso, y una pausa es un link roto.
- **Acortador externo (bit.ly, short.io):** datos de leads en un tercero, y dominios con mala
  reputación anti-spam.
- **Página estática que arma el texto:** el copy quedaría duplicado entre la página y
  `programs.js`.
