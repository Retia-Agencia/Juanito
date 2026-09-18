# Segunda fuente del teléfono del lead: cada Conexión declara la suya

## Status

accepted (2026-09-18) — en producción. Evidencia, medidas y detalle de implementación en
§18.CA del [handoff](../JUANITO-HANDOFF.md).

## Contexto

El teléfono del lead es el dato del que cuelga TODO el valor del push precall: sin él no hay link
`wa.me` y el push degrada a "mándalo manual". Juanito lo saca de Calendly, y Calendly lo entrega
por dos vías (`invitee.text_reminder_number`, la casilla nativa de SMS, o una pregunta del
formulario de reserva).

**Ninguna de las dos es confiable, y lo son por razones distintas.**

- La casilla nativa es OPCIONAL y casi nadie la llena. Medido el 2026-09-18: en el Calendly de 30X,
  1448 citas en septiembre, la casilla llena en **15**. En ComunicArte, 7 de 93.
- La pregunta del formulario es TEXTO LIBRE. Cubre al 90% de los leads (por eso los dos programas
  de Retia la pusieron obligatoria), pero lo que llega es lo que el lead teclea, con sus typos.

30X vivió con esto sin notarlo porque tiene una segunda fuente: sus leads están en el HubSpot que
Juanito tiene conectado, y `resolvePhone` cae ahí cuando Calendly no trae número. Las dos
conexiones de Retia son las únicas con `hubspot:false`, o sea las únicas **sin red**.

El incidente que lo destapó: Michael, de operaciones de Retia, reportó que Juanito "pone los
números mal", con el lead Gustavo Laguna de ejemplo. No los pone mal: los copia tal cual. El lead
escribió `+57 300 3018595` en Calendly y `+573006018595` en el formulario del anuncio. Un dígito.
Cruzando por email exacto, **9 de 175 citas comparables (5%) tienen esa discrepancia**.

Y el detalle que decide el diseño: **validar la forma no sirve.** `+57 300 3018595` es un móvil
colombiano impecable (prefijo 300, diez dígitos). Ningún validador puede saber que no es de
Gustavo. Este error solo existe contra una segunda fuente.

## Decisión

**1. La segunda fuente del teléfono es una propiedad de la Conexión, no una rama de código.**
Cada Conexión declara de dónde sale su respaldo. Hoy hay dos formas y conviven:

| Conexión | Segunda fuente | Cómo se declara |
|---|---|---|
| `30x`, `estadox` | HubSpot | `hubspot: true` |
| `retia`, `comunicarte` | El formulario del anuncio (Google Sheet) | `leadForm: { id, tab, emailCol, phoneCol }` |

Declararlo ES el interruptor: una Conexión sin `leadForm` no hace el cruce ni la búsqueda. Es el
mismo patrón que ya usan `sheets` (Push 5) y `push4` en ese registro, y la misma
auto-desactivación del resto del sistema. Agregar una Conexión nueva sin formulario la deja
exactamente como está hoy, sin tocar código.

**2. Ante una discrepancia, Juanito NO elige: muestra las dos y le pasa la decisión al closer.**
De las 9 discrepancias medidas, cinco son de un dígito, dos de dos dígitos, y dos son números
enteramente distintos (una lead vive en España y tiene línea allá y en Colombia). **No todo lo que
difiere es un typo**, y el sistema no tiene cómo saber cuál de los dos es el bueno. Los pushes que
llevan link salen con los dos, rotulados por lead y por fuente.

**3. El cruce se hace por EMAIL exacto, nunca por nombre.** Es una restricción de seguridad del
dato, no de estilo: el primer cruce de la investigación se hizo por nombre y le asignó a "Gustavo
Laguna" el teléfono de un desconocido, porque en el formulario ese lead figura como "Gustavo
Adolfo Laguna Leal". **Un push a un número equivocado es peor que un push sin número.** Fijado con
test.

**4. La segunda fuente nunca puede tumbar un push.** Si la hoja falla —sin credenciales, 403, hoja
vacía, Sheets caído— el lector devuelve `null` y el push sale exactamente como salía antes. La
disponibilidad del push no depende de un servicio de terceros que solo lo mejora.

## Alternativas descartadas

**Prender la casilla nativa de Calendly y confiar en ella.** Fue la primera propuesta y se midió
antes de descartarla. Falla dos veces: ya está prendida y la llena el 7% de los leads (quitar la
pregunta para apoyarse en ella devolvería a Retia a los 143 pushes sin teléfono al mes de agosto),
y aunque la llenaran, valida forma y no propiedad — no habría atrapado a Gustavo.

**Validar mejor el número.** Mismo techo: el número equivocado es válido. Cualquier regla de forma
lo deja pasar, y cualquier regla más agresiva empieza a rechazar números legítimos de otros países
(el 12% de las citas de Retia son de México, Ecuador, Argentina o España).

**Clasificar "typo" contra "dos líneas reales" y corregir automáticamente.** Todo umbral se
equivoca en el medio del rango medido, y la acción del closer es la misma en los tres casos. Un
clasificador agrega umbral, tests y falsos negativos sin cambiar el resultado. Además, pisar el
número de Calendly con el de la hoja es escribirle a alguien con un dato que nadie confirmó.

**Guardar el número alterno en `calendly_pushes`** para que todos los consumidores lo lean de la
fila. No sirve: el digest (Push 1/2) no se arma desde la tabla, re-lista las citas contra Calendly
en vivo. Habría agregado una columna y una migración sin cubrir al consumidor que la motivaba.

## Consecuencias

- **Juanito depende de Google Sheets en el camino del push**, pero solo para mejorarlo. La lectura
  es read-only, va con deadline y su fallo es inerte. La credencial ya existía (`GOOGLE_SA_KEY`, la
  misma del reporte diario de leads): no se agregó ninguna dependencia ni ningún secreto.
- **Hay un lugar más que se desactualiza si Retia cambia de formulario.** Si mueven la pestaña o
  renombran la hoja, el cruce se apaga en silencio y los pushes vuelven a como estaban. El log dice
  `⚠️ no pude leer el formulario de <conexión>` en cada ciclo, que es dónde mirar.
- **El índice se lee una vez por corrida, no por cita** (`makeFormIndexCache`). Con hojas de 2.000 y
  3.900 filas y un poll cada 5 minutos, leerlas por cita sería decenas de llamadas por ciclo.
- **Queda una asimetría declarada**: las citas que el digest suma desde HubSpot no pasan por el
  cruce. Es correcto —esas son de 30X, que tiene su propia segunda fuente— pero es una regla que
  hay que recordar al leer `runDigest`.
