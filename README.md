# Second Brain Agent 🧠

Agente personal de WhatsApp con memoria, recordatorios y resumen de grupos.
Construido con Claude (Anthropic), Meta Cloud API y OpenWA.

## Arquitectura

```
WhatsApp del jefe ──► OpenWA (VPS) ──► webhook ──► Agente
                                                       │
Número del bot ◄──── Meta Cloud API ◄────────────────┘
                                                       │
                                                   Claude API
                                                   SQLite (memoria)
```

- **Número del bot** → Meta Cloud API oficial (sin riesgo de ban)
- **Número del jefe** → OpenWA + whatsapp-web.js (lectura de grupos)
- **Cerebro** → Claude con memoria persistente en SQLite
- **Proactividad** → Scheduler de recordatorios + resúmenes de grupos cada 4h

## Requisitos previos

- VPS en DigitalOcean (el que ya tenés)
- Docker + Docker Compose instalados
- Cuenta de Meta Business con Cloud API activada
- Instancia de OpenWA corriendo con el número del jefe conectado
- API key de Anthropic

## Setup

### 1. Clonar el repo

```bash
git clone https://github.com/TU_USUARIO/second-brain-agent.git
cd second-brain-agent
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
nano .env   # completar todos los valores
```

Variables obligatorias:
| Variable | Descripción |
|---|---|
| `ANTHROPIC_API_KEY` | Tu API key de Anthropic |
| `META_PHONE_NUMBER_ID` | ID del número del bot en Meta Business |
| `META_WHATSAPP_TOKEN` | Token de acceso de Meta |
| `META_VERIFY_TOKEN` | Token que vos elegís para verificar el webhook |
| `META_APP_SECRET` | App Secret de Meta — valida la firma de los webhooks entrantes |
| `BOSS_PHONE` | Número del jefe (ej: `573001234567`) |
| `OPENWA_API_KEY` | API key de tu instancia OpenWA |
| `OPENWA_SESSION_ID` | ID de la sesión del jefe en OpenWA |
| `OPENWA_WEBHOOK_SECRET` | Secret HMAC para validar webhooks de OpenWA |
| `PUBLIC_URL` | URL pública del VPS (ej: `https://tudominio.com`) |

> **Seguridad:** `META_APP_SECRET` y `OPENWA_WEBHOOK_SECRET` no son estrictamente
> obligatorios para que arranque, pero **sin ellos cualquiera que conozca tu URL
> puede inyectar mensajes falsos**. Configuralos antes de exponer a internet.

### 3. Levantar los servicios

```bash
docker compose up -d
```

### 4. Configurar webhook en Meta

En Meta Business Manager → WhatsApp → Configuración → Webhooks:
- URL: `https://tudominio.com/webhook/meta`
- Token de verificación: el valor de `META_VERIFY_TOKEN`
- Suscribirse a: `messages`

### 5. Conectar el número del jefe en OpenWA

```bash
# Entrar al dashboard de OpenWA
open http://localhost:2886

# O via API:
curl -X POST http://localhost:2785/api/sessions \
  -H "X-API-Key: TU_OPENWA_KEY" \
  -d '{"name": "jefe"}'
```

Escanear el QR con el WhatsApp del jefe.

## Uso

Una vez configurado, el jefe le escribe al número del bot:

```
"recuérdame llamar al banco mañana a las 10am"
"¿qué pasó en el grupo de proveedores hoy?"
"guarda que mi número de cuenta es 1234567"
"¿qué tengo pendiente para esta semana?"
```

## Estructura del proyecto

```
src/
├── index.js          # Entry point, servidor Express, verificación de firmas
├── bot/index.js      # Orquestador central (dedup, autorización)
├── claude/index.js   # Llamadas a Claude con memoria + tool use + reintentos
├── meta/index.js     # Envío/recepción via Meta Cloud API
├── openwa/index.js   # Lectura de chats del jefe
├── scheduler/index.js # Recordatorios, resúmenes y limpieza automática
├── common/utils.js   # Normalización de teléfonos y verificación HMAC
└── db/
    ├── index.js      # Funciones de acceso a SQLite
    └── migrate.js    # Creación de tablas e índices
```

## Desarrollo local

```bash
npm install
cp .env.example .env  # completar .env
npm run migrate       # crear tablas
npm run dev           # arrancar con hot reload
```

## Logs

```bash
docker compose logs -f agent       # logs del agente
docker compose logs -f openwa-api  # logs de OpenWA
```
