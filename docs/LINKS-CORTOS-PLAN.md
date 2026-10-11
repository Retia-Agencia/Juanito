# Links cortos para los pushes — plan de análisis

> Estado: **análisis, sin código.** Este documento define qué hay que averiguar y probar ANTES de
> construir. Sale de él un ADR (0004), una spec corta y los tickets. Abierto el 2026-10-10.

## Qué queremos

Hoy cada lead del digest lleva un link `https://wa.me/<tel>?text=<mensaje entero codificado>` de
~1.100-1.500 caracteres. El mensaje a Andrea del viernes midió 15.091 caracteres para 12 leads.
Queremos que el closer reciba `https://<host>/l/a8Kx2Qp` (~40 caracteres) y que, al tocarlo, se
abra el mismo chat con el mismo texto listo para enviar.

Ganancias: mensajes ~10x más cortos, ningún carácter del texto puede volver a partir el link
(incidente del 2026-10-09, "(hora Colombia)"), y de paso sabemos si el closer tocó el link.

Importante: **el lead nunca ve el link corto.** Lo ve solo el closer; al lead le llega el texto.

## La regla que manda: los pushes de hoy no cambian

Todo el diseño se juzga contra esto. Cuatro garantías, cada una verificable:

1. **Apagado = byte por byte igual.** Con el interruptor apagado, todos los builders devuelven
   exactamente el mismo texto que hoy. Se fija con tests "golden" que se escriben ANTES de tocar
   nada (ver §Pruebas).
2. **Nunca un push sin link.** Si acuñar el link corto falla (DB ocupada, lo que sea), el push sale
   con el link largo de siempre. El link corto es una mejora, nunca un punto de falla nuevo.
3. **El redirector no vive en el proceso del bot.** Si se cae o tiene un bug, WhatsApp no se entera
   (mismo argumento de crash domain del ADR 0002: `process.exit(1)` + backoff de hasta 5 min).
4. **Se apaga sin reiniciar el bot.** Un cambio de env obliga a recrear el contenedor y eso
   reconecta Baileys. El interruptor tiene que vivir en la DB (tabla `settings`) y moverse con un
   comando, como ya hace `/espejo`.

## Lo que ya está medido (inventario)

Builders que llevan wa.me, todos en `src/calendly/index.js` y todos puros:

| Builder | Push | Cuándo se arma | Ojo |
|---|---|---|---|
| `buildPush3Message` (:457) | Push 3 | **Al agendar**, hasta ~48 h antes; se guarda en `calendly_pushes.message` | El link se acuña mucho antes de enviarse; una reagenda reescribe el mensaje |
| `buildRescheduleMessage` (:520) | Reagenda correctiva | Al detectar la reagenda | Lleva el link con el horario nuevo |
| `buildPush0Message` (:585) | Push 0 | Al reservar | §18.CA: dos números → dos links |
| `buildDigestMessage` (:618) | Push 1, 2, viernes | Al enviar | Hasta 17 links en un mensaje |
| `buildLeadLink` (:441) | todos | — | Único punto que arma la URL |

Consumidores del texto ya armado que hay que revisar uno por uno:

- `extraJids` (copia al segundo aparato) y el espejo de dev: reciben el mismo texto. ¿El clic desde
  el aparato secundario debe contar distinto?
- `wa_outbound.message`: guarda el proto para reintentos. Un reintento manda el mismo link corto;
  hay que confirmar que siga vivo.
- `blocklist.mentionsBlockedPhone`: busca el número del troll en el texto. Hoy lo encuentra en claro
  ("📞 +57…") **y** dentro del wa.me. Con link corto solo queda en claro: verificar con test que
  sigue bloqueando, incluido el teléfono alterno del formulario.
- `dashboard/server/queries.js:123` (`motivoDeSkip`) lee `calendly_pushes.message`.
- Los tests actuales que hacen assert sobre el contenido del wa.me.

## Preguntas a cerrar (en este orden)

Cada fase tiene un método y una condición de salida. No se pasa a la siguiente sin cerrarla.

### A. ¿El link corto funciona en el teléfono real? (antes de cualquier código)

Es lo más barato de probar y lo que puede matar la idea entera.

- Montar un redirect de prueba a mano (una sola URL fija, 302 → un wa.me con texto de prueba al
  número de Mani).
- Probar en **Android, iPhone y WhatsApp Web**, que son los aparatos de los closers. Preguntas:
  ¿WhatsApp convierte el link corto en link? ¿Al tocarlo pasa por el navegador y abre WhatsApp con
  el texto completo, emojis, saltos de línea y tildes intactos? ¿iOS muestra una pantalla
  intermedia que el closer tenga que tocar?
- ¿WhatsApp o algún antivirus visita el link solo (vista previa)? Si sí, el conteo de clics sale
  inflado y eso define si la métrica de clics sirve.
- **Salida:** tabla aparato × resultado. Si un aparato falla, se para aquí.

### B. ¿Dónde vive el redirector? (ADR 0004)

> **Decidido el 2026-10-10:** Cloudflare Worker + D1, solo para los programas de Retia. Ver
> [ADR 0004](adr/0004-links-cortos-en-cloudflare.md). La comparación queda abajo como registro.

Choca con el ADR 0002: "ningún `ports:` publicado hacia internet". Y los closers no están en el
tailnet, así que el redirector tiene que ser público. Opciones, en tres familias:

**1. Redirector en el VPS** (los datos no salen; si el VPS se cae, los links mueren)

| Opción | Cómo entra el tráfico | IP del VPS | Costo |
|---|---|---|---|
| 1a. Contenedor propio + **Tailscale Funnel** | Relay de Tailscale, sin `ports:` | Oculta | 0 |
| 1b. Contenedor propio + **Cloudflare Tunnel** (`cloudflared`) | Túnel saliente, sin `ports:` | Oculta | 0, pero pide un dominio en Cloudflare |
| 1c. Puerto abierto + Caddy + dominio | Directo a la IP | **Expuesta**: un ataque a esa IP pega en la conexión de WhatsApp, que depende de ella | Dominio |

**2. Redirector fuera del VPS** (el bot solo hace HTTPS saliente para guardar el link; si el VPS se
cae, los links siguen vivos; el teléfono y el texto quedan en una cuenta propia)

| Opción | Vencimiento | Limitación |
|---|---|---|
| 2a. **Cloudflare Worker + KV** | Nativo (TTL por llave) | Plan gratis: ~1.000 escrituras/día (a confirmar contra el volumen real); `*.workers.dev` sin comprar dominio |
| 2b. Vercel Function + Redis/Edge Config | A mano o por TTL de Redis | El plan Hobby es solo uso no comercial → Pro, ~20 USD/mes |
| 2c. Supabase Edge Function + tabla | A mano | URL más larga (`…supabase.co/functions/v1/l/…`); el plan gratis se pausa tras días sin uso |

**3. Sin redirector con estado**

| Opción | Idea | Problema |
|---|---|---|
| 3a. Acortador externo (bit.ly, short.io) | API de terceros | Datos del lead a un tercero, límites del plan gratis, dominios de acortador con mala reputación anti-spam |
| 3b. Página estática que arma el texto | Link `https://host/p#ti.Jimmy.573123713803.1210.0900`: la página trae las plantillas del copy y arma el wa.me en el navegador. Lo de después de `#` nunca llega al servidor | Copy duplicado: la página y `programs.js` pueden quedar desfasadas, y un cambio de copy obliga a redesplegar la página |
| 3c. Sin link de texto | El closer recibe `wa.me/<tel>` corto + el texto aparte para copiar y pegar | Más fricción para el closer: es justo lo que el wa.me con texto vino a quitar |

Criterios: que no toque el socket de Baileys, crash domain, qué pasa si se cae, privacidad,
operación (quién paga, quién tiene la cuenta).

**Mediciones del 2026-10-10** (`wa_outbound` con cuerpo existe solo desde el 2026-10-08):

- Días hábiles con ~130 citas: ~200 mensajes de push, ~300 links wa.me enviados, **~273 links
  distintos** por día. Ese número es lo que el redirector guardaría a diario. Se cuenta en días UTC.
- Pico de citas en 30 días: 141/día → se proyectan ~300 links por día.
- El 78% de los caracteres que Juanito les manda a los closers son links (178k de 227k el
  2026-10-08). El mensaje más largo pesó 20.259 caracteres (Push 1 de Andrea, 17 links); con links
  cortos quedaría en ~1.300.
- Cloudflare KV gratis: 1.000 escrituras/día → margen de ~3x sobre el pico.
- Upstash gratis (Redis para Vercel): 500k comandos/mes; se usarían ~20k (~4%).
- Vercel Hobby: el uso comercial exige Pro o Enterprise según su política de uso justo. Con el MCP
  no se pudo leer el plan del equipo `manigreen`.
- Tailscale 1.98 en el VPS, con `serve` del dash en :443 solo dentro del tailnet; Funnel apagado.
  Funnel abre un puerto entero: prenderlo en :443 publicaría el dash. Tendría que ir en :8443 o
  :10000, solo con el redirector.

**Salida:** ADR 0004 aceptado por Mani, que enmiende el 0002 de forma explícita.

### C. Modelo de datos

- Tabla `short_links`: `id`, `url` (wa.me completo), `event_uuid`, `push_n`, `closer_email`,
  `created_at`, `expires_at`, `clicks`, `first_click_at`.
- Id: ¿cuánta entropía? (8 caracteres base62 ≈ 47 bits: imposible de adivinar a mano). ¿Mismo
  lead + mismo texto = mismo id, o uno nuevo cada vez?
- Vencimiento: ¿cuándo? (¿hora de la llamada + 1 día?). ¿Qué ve quien toca un link vencido? ¿Una
  página "este link venció" o se redirige igual?
- Quién crea la tabla: **no** `migrate.js` (si falla, el bot no arranca; ver ADR 0002). Módulo
  propio con `CREATE TABLE IF NOT EXISTS`, como hace el dash.
- Si el redirector vive fuera del VPS (opción Cloudflare), ¿la fuente de verdad es la KV o SQLite?

### D. Cómo entra al código sin romper la pureza

- Los builders siguen puros: reciben una función `linkFor(phone, text)` que por defecto es
  `buildLeadLink`. El scheduler inyecta la versión que acuña si el interruptor está prendido para
  esa conexión. Con eso los tests puros no cambian.
- **Push 3 es el caso difícil:** el link se acuña al agendar y se envía horas después. ¿Se acuña al
  agendar (más simple) o al enviar (link siempre fresco)? Si una reagenda reescribe el mensaje, el
  link viejo ¿se invalida o sigue vivo apuntando al horario viejo?
- Envíos desde el bot: la escritura a `short_links` ocurre en el proceso principal, con
  `busy_timeout` ya puesto.

### E. Seguridad

- **Sin open redirect:** el redirector solo manda a URLs que estén guardadas y empiecen por
  `https://wa.me/`. Nunca lee el destino de la query.
- Rate limit y respuesta igual para "no existe" y "vencido" (que no se pueda enumerar).
- Logs sin teléfonos ni texto del lead.
- Un link reenviado a un tercero muestra lo mismo que hoy (el texto y el teléfono). No empeora, pero
  hay que decirlo en el ADR.

### F. Si el redirector se cae, ¿quién se entera?

Hoy un link largo no se puede caer. Con link corto aparece un modo de falla nuevo y silencioso: el
closer toca, no pasa nada, y no avisa. Hace falta un chequeo periódico (el watchdog del dash ya
existe) que pida un link de prueba y alerte por `reminders` si falla. Sin esto no se prende.

### G. Rollout y vuelta atrás

1. Desplegar con todo apagado → los tests golden prueban que nada cambió.
2. **Modo sombra:** acuña y registra el link corto, pero manda el largo. Sirve para medir errores
   al acuñar sin tocar a nadie.
3. **Piloto:** una conexión (Retia, Andrea), con `/linkscortos on retia`.
4. Una semana sin incidentes → resto de conexiones, una por una.

Rollback en cualquier punto: `/linkscortos off <conexión>`, sin reiniciar nada. Los links ya
enviados siguen funcionando mientras el redirector viva.

## Pruebas que protegen los pushes actuales

- **Golden tests primero**, antes de tocar código: snapshot del texto exacto de cada builder (Push
  0, 1, 2, 3, viernes, reagenda, dos números de §18.CA, digest multi-programa) con datos fijos.
  Con el interruptor apagado tienen que seguir pasando sin cambiar ni un byte.
- Tests con el interruptor prendido: un link corto por lead, el número sigue en claro, la blocklist
  sigue bloqueando.
- Test de fallback: si acuñar falla, sale el link largo.
- Redirector: 302 correcto, 404 sin distinguir vencido/inexistente, rechaza destinos que no sean
  wa.me.
- Suite completa en Linux contra la línea base (1232 verdes / 2 rojos conocidos al 2026-09-18).

## Lo que necesita a Mani

- Dónde vive el redirector (fase B). Es la decisión grande.
- Qué closer hace el piloto y en qué aparatos (fase A).
- Cuánto vive un link y qué ve quien toca uno vencido (fase C).
- Si la métrica de clics se muestra en el dash o solo se guarda.

## Fuera de alcance

- Acortar links que no son wa.me (video, brochure, link de la llamada).
- Cambiar el copy de los pushes.
- El arreglo de los paréntesis (`buildLeadLink` codifica `!'()*`): va aparte y antes, porque
  protege los pushes desde ya, con o sin links cortos.

## Entregables del análisis

1. Tabla de pruebas en aparatos (fase A).
2. ADR 0004: redirector público y su relación con el ADR 0002.
3. Spec corta con las respuestas de las fases C a G.
4. Tickets para Codex, con los golden tests como primer ticket.
