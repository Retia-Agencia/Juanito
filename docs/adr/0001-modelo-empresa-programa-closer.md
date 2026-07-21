# Modelo de primera clase: empresa / programa / conexión / closer (Calendly)

## Status

accepted (2026-07-21) — diseño grillado; ejecución pendiente. Implementa handoff §18.AJ.

## Contexto

Al entrar Retia (segunda agencia con su propio Calendly) quedó claro que el modelo
"1 cuenta = 1 empresa" es falso: una **Connection** (token+org de Calendly) sirve N
**Programs** (30x → 6) o 1 (retia), y una **Company** (marca) reparte sus programas en
N conexiones. Sumar un programa hoy toca 5 lugares en 2 archivos sin nada que valide
consistencia, y un mismo closer cross-conexión (Sebastian Rodriguez: 30X + Retia) obliga
a dos entradas con nombre repetido. La restricción que manda sobre todo: **no romper lo
live** — el copy de los tres pushes precall de cada programa debe quedar byte-idéntico.

## Decisión

- **Program es objeto de primera clase.** Un registro `PROGRAMS` keyeado por programKey es
  la fuente única; los mapas de hoy (`eventTypeToProgram`, `PROGRAM_LABELS`, `PROGRAM_PITCH`,
  `MATERIAL_LINKS`, `eventTypes` por conexión) se **derivan** de él con firma y salida
  idénticas → cero cambios en callers, la red de tests byte-idéntico aplica tal cual.
- **Company es solo un label** (campo en Program), no un objeto. Ninguna lógica se bifurca
  por marca. Puede graduar a objeto si aparece una conducta suya; ese ruteo colgaría de la
  Connection, no de la marca.
- **Closer = persona con identidades.** El roster se autora keyeado por PERSONA
  (`{ name, identities: { <conn>: {hostEmail, phone, workLid?} } }`); de ahí se derivan el
  `CLOSERS` por email y `resolveCloser*`/`accountOfCloser` con firma idéntica. Sebastian =
  una entrada, dos identidades. La entrega y el opt-in siguen resolviendo por Identidad
  (teléfono/email), no por la persona.
- **"connection" solo en el código nuevo.** Los exports existentes (`ACCOUNTS`, `accountOf*`,
  `activeAccounts`) conservan su nombre como capa derivada/compat; el término del modelo es
  Connection. Rename total → posible phase 2, no ahora.
- **Alcance = reshape puro.** Las deudas de §18.AH (`/calendly off <cuenta>`, throttle por
  token, `notifyAdmins` por conexión) son cambios de comportamiento y quedan como follow-ups.
  Regla de secuencia: `/calendly off <cuenta>` debe aterrizar **antes** de sacar a Retia de
  dry-run (hoy el botón de pánico global apagaría ambas empresas).

## Consecuencias

- La PK `calendly_optins.phone` **no se migra**: cada identidad tiene su propio teléfono, no
  chocan. La clave compuesta `(phone, connection)` queda documentada como contingencia solo
  para el caso (inexistente hoy) de una persona con el mismo número en dos conexiones.
- "Misma persona" es una decisión de autoría explícita (dos identidades bajo una entrada),
  NO algo que el código infiera del nombre. La person key debe ser un slug/id deliberado, no
  derivado del nombre, para no colisionar homónimos reales.
- `resolveCloserByPushName` con nombre repetido en dos identidades → dos teléfonos → `null`
  (ambiguo = seguro): comportamiento idéntico al de hoy, no reabre el secuestro de pushes.
