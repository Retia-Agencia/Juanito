# Juanito — Agente personal de WhatsApp

Asistente IA personal conectado directamente a WhatsApp via Baileys.
Vive en un VPS, escucha grupos y chats, responde cuando lo mencionan,
crea recordatorios y recuerda cosas importantes del jefe.

## Arquitectura

```
Teléfono (SIM del bot)
    │  Baileys (WebSocket persistente)
    ▼
Node.js app (Docker, VPS)
├── Message router
│   ├── Grupo + mención → Claude responde en el grupo
│   └── DM del jefe    → Claude responde al jefe
├── Claude API (tool use: recordatorios, memoria, resúmenes)
├── SQLite  (historial, memoria, grupos, recordatorios, contactos)
└── Scheduler (recordatorios cada 1min, resúmenes cada 4h, limpieza 3am)
```

Un solo container. Sin Meta API. Sin servicios externos.

## Requisitos

- VPS con IP fija (DigitalOcean o similar) y Docker instalado
- SIM física dedicada para el bot (número de WhatsApp)
- API key de Anthropic

## Setup

### 1. Clonar y configurar

```bash
git clone <repo> juanito && cd juanito
cp .env.example .env
nano .env  # completar ANTHROPIC_API_KEY, BOSS_PHONE, AGENT_PHONE
```

Variables obligatorias:

| Variable | Descripción |
|---|---|
| `ANTHROPIC_API_KEY` | API key de Anthropic |
| `BOSS_PHONE` | Número del jefe sin `+`, ej: `573001234567` |
| `AGENT_PHONE` | Número del bot con `+`, ej: `+573009998877` (solo para el primer vinculado) |

### 2. Levantar

```bash
docker compose up -d --build
```

### 3. Vincular WhatsApp (primera vez)

```bash
docker compose logs -f agent
# Esperar hasta ver el código de 8 dígitos:
# 📱 Código de vinculación: XXXX-XXXX
```

En el teléfono físico:
**WhatsApp → Dispositivos vinculados → Vincular con número de teléfono → ingresar el código**

La sesión queda guardada en el volumen `agent-data`. No hace falta repetir este paso en reinicios.

### 4. Agregar el bot a los grupos

Desde el teléfono del jefe, agregar el número del bot a cada grupo relevante.
El bot comenzará a escuchar y guardar mensajes automáticamente.

## Uso

El jefe le escribe al número del bot:

```
"recuérdame llamar al banco mañana a las 10am"
"¿qué pasó en el grupo de proveedores hoy?"
"guarda que mi cuenta de banco es 1234567"
"¿qué tengo pendiente esta semana?"
"recuérdale a Juan el lunes a las 9 que tiene reunión"
```

En grupos, mencionar al bot por su nombre (`BOT_NAME`):

```
"@Juanito ¿qué se decidió sobre el presupuesto?"
```

## Contactos (para recordatorios a terceros)

```bash
# Local
npm run contact -- "Juan" "+57 300 111 2222"
npm run contact -- --list

# En el VPS
docker compose exec agent node scripts/add-contact.js "Juan" "573001112222"
```

## Estructura

```
src/
├── index.js            Entry point: conecta Baileys y wira handlers
├── whatsapp/index.js   Cliente Baileys (connect, sendMessage, listGroups, ...)
├── bot/index.js        Router: DM del jefe vs. mención en grupo
├── claude/index.js     Claude con tool use y memoria
├── scheduler/          Cron jobs: recordatorios, resúmenes, limpieza
├── db/                 SQLite: schema, migración, funciones de acceso
├── contacts/           Directorio de contactos (resolver nombre → número)
└── common/utils.js     Normalización de teléfonos, HMAC
entrypoint.sh           Backoff exponencial entre reinicios (evita softban)
```

## Logs y operación

```bash
docker compose logs -f agent     # logs en tiempo real
docker compose restart agent     # reiniciar sin bajar la sesión de WA
docker compose down              # bajar (la sesión queda en el volumen)
```

## Reinicios y seguridad de la sesión

`entrypoint.sh` implementa backoff exponencial: 30s → 60s → 120s → 240s → 300s.
Después de 8 fallos consecutivos, Docker aplica su propia política de restart.
Esto evita el loop rápido de reconexiones que puede triggerear detección de WhatsApp.

La sesión de Baileys persiste en el volumen `agent-data:/app/data/wa-session`.
No se pierde en reinicios normales.
