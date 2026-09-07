# Calendly / Precall (Juanito)

Lenguaje del dominio de los recordatorios precall a closers: quién vende qué, por
cuál cuenta de Calendly, y a quién se le entrega cada push. Existe porque el modelo
"1 cuenta = 1 empresa" dejó de ser cierto al entrar una segunda agencia (Retia). Hoy no vale
en NINGUNA de las dos direcciones: una cuenta puede servir a dos marcas (`30x` → 30X y EstadoX)
y una empresa puede tener dos cuentas (Retia → una por programa). La unidad es el PROGRAMA.

## Language

**Closer**:
Una PERSONA que toma llamadas de venta. Tiene una o más Identidades (una por Conexión).
La entrega de pushes y el opt-in se resuelven por Identidad, no por la persona.
_Avoid_: agente, vendedor, host.

**Identity** (Identidad):
La presencia de un Closer dentro de UNA Conexión: su email de host en ese Calendly, su
teléfono canónico y, si aplica, su LID de trabajo. Es la clave real de entrega y opt-in.
Una persona que cierra para dos empresas tiene dos Identidades (distinto email y teléfono).
_Avoid_: cuenta del closer, número.

**Company** (Empresa / marca):
La marca de cara al lead (30X, EstadoX, Retia). Por ahora es SOLO un label de un Program,
sin comportamiento ni ciclo de vida propio: ninguna lógica se bifurca por empresa. Puede
graduar a objeto más adelante si aparece una conducta suya (p. ej. ruteo de alertas por
equipo), pero ese ruteo naturalmente cuelga de la Conexión, no de la marca.

⚠️ **REGLA DE LECTURA, y se rompe seguido: una Empresa NO tiene Calendly. Los Programas sí.**
Retia es la empresa (la agencia) y maneja DOS programas —"De Cero a Tactical Investor" y
"Método Comunicarte"—, cada uno con su propia cuenta de Calendly ⇒ **dos Conexiones**.
Exactamente igual que 30X, que es empresa y maneja seis programas (esos sí comparten un
Calendly, que es la asimetría del sistema, no la regla). Decir "el Calendly de Retia" o
"la conexión Retia" es un error de modelo: no existe tal cosa.
_Avoid_: cuenta, agencia (esos son Connection); "el Calendly de <empresa>".

**Connection** (Conexión):
Una cuenta de Calendly conectada: su token, su organización y los event_types que Juanito
pushea de ella. Es la unidad de autenticación y polling, y el scope natural del rate limit,
las alertas de "closer sin mapear" y el off-switch. Una Connection puede servir N Programs
(30x sirve 6) o 1 (`retia`, `comunicarte`, `estadox`). En el código existente se llama
`account`/`ACCOUNTS` (se conserva ese nombre en la capa derivada); "Connection" es el término
del modelo nuevo.

⚠️ **Las KEYS de las conexiones no son nombres de empresa, aunque dos lo parezcan.** `retia`
es el Calendly del programa **De Cero a Tactical Investor**, no "la cuenta de Retia": la key
quedó de cuando ese era el único programa de Retia acá (2026-07-21). Igual `30x`, que hostea
programas de DOS marcas (30X y EstadoX). Las keys se conservan porque son la clave del roster,
de los opt-ins, de las filas ya guardadas y de los nombres de sus env (`CALENDLY_TOKEN_RETIA`):
renombrarlas es una migración con riesgo de dejar un programa mudo, no un rename. **Los LABELS
sí dicen la verdad** (`Retia · Tactical Investor`, `Retia · ComunicArte`, formato
`empresa · programa`) y son lo que ve el humano en `/calendly`, `/espejo` y el espejo de dev.
_Avoid_: cuenta (ambiguo con la de banco), empresa.

**Program** (Programa):
Un producto vendible con su propio pitch, materiales y event_type de Calendly (Second Brain,
IA para Abogados, De Cero a Tactical Investor). Objeto de primera clase del modelo nuevo:
un registro PROGRAMS keyeado por programKey del que se DERIVAN los mapas de hoy. Cada Program
nombra su Connection (quién lo hostea) y su Company (marca de cara al lead). El programa de una
cita se deriva de su event_type, no se almacena en el Closer.
_Avoid_: producto, curso.

**Invariante — no romper lo live**:
El copy de los tres pushes precall de CADA programa debe quedar BYTE-IDÉNTICO antes/después
del refactor. Es reshaping de datos, no de lógica. Los tests de copy son la red.
