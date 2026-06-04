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
| `META_WABA_ID` | WhatsApp Business Account ID (gestión de templates) |
| `REMINDER_TEMPLATE_NAME` | Nombre del template de utilidad aprobado para recordatorios |
| `REMINDER_TEMPLATE_LANG` | Idioma del template (ej: `es` / `es_CO`) |
| `AGENT_PORT` | Puerto del host en el VPS (cámbialo si 3000 está ocupado) |
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

## Recordatorios a terceros y templates de Meta

Para recordatorios como _"Recuérdale a Juan mañana a las 9am"_, el bot le escribe a **un
número que no inició conversación con él**, es decir **fuera de la ventana de servicio de
24 h**. Meta solo permite eso con un **template de utilidad aprobado**.

El bot decide solo el canal:
- **Dentro de la ventana 24 h** (el jefe te acaba de escribir) → mensaje de **texto** gratis.
- **Fuera de la ventana / a un tercero** → **template** (`REMINDER_TEMPLATE_NAME`).

### Crear el template en Meta Business Manager
1. Meta Business Manager → WhatsApp Manager → **Plantillas de mensajes** → *Crear plantilla*.
2. Categoría: **Utilidad (Utility)**. Idioma: el de `REMINDER_TEMPLATE_LANG` (ej: `es`).
3. Nombre: el mismo de `REMINDER_TEMPLATE_NAME` (ej: `reminder_utility`).
4. Cuerpo con **una variable** `{{1}}`, por ejemplo:
   `⏰ Recordatorio: {{1}}`
5. Enviar a aprobación. Cuando quede **APROBADO**, ya funciona.

> En desarrollo, el sandbox de Meta permite probar sin template aprobado dentro de la
> ventana de 24 h. Los recordatorios a terceros requieren el template en producción.

### Directorio de contactos
Para resolver _"Juan"_ → número, cargá contactos con el script incluido (sin SQL):

```bash
# local
npm run contact -- "Juan" "+57 300 111 2222"
npm run contact -- --list

# en el VPS (dentro del contenedor)
docker compose exec agent node scripts/add-contact.js "Juan" "573001112222"
```

Si el jefe dicta un número directamente, el bot lo usa sin necesidad de tenerlo guardado.

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

## Producción (VPS)

El VPS ya corre otro bot que **no se debe tocar**. Para evitar choques:

1. **Puerto sin colisión.** El compose publica el agente en `127.0.0.1:${AGENT_PORT}` (default
   3000). Verificá que esté libre y, si no, cambiá `AGENT_PORT` en `.env`:
   ```bash
   sudo ss -ltnp | grep -E ':3000|:2785'   # ver qué hay ocupado
   # si 3000 está en uso: poné AGENT_PORT=3100 en .env
   ```
2. **nginx + HTTPS** (Meta exige HTTPS para los webhooks):
   ```bash
   sudo cp deploy/nginx.conf /etc/nginx/sites-available/second-brain
   sudo nano /etc/nginx/sites-available/second-brain   # poner tu dominio (y AGENT_PORT si lo cambiaste)
   sudo ln -s /etc/nginx/sites-available/second-brain /etc/nginx/sites-enabled/
   sudo certbot --nginx -d tudominio.com
   sudo nginx -t && sudo systemctl reload nginx
   ```
3. **Levantar y migrar:**
   ```bash
   docker compose up -d --build
   docker compose exec agent node src/db/migrate.js   # idempotente
   curl -s http://127.0.0.1:${AGENT_PORT:-3000}/health
   ```

## Logs

```bash
docker compose logs -f agent       # logs del agente
docker compose logs -f openwa-api  # logs de OpenWA
```
