# CLAUDE.md — Contexto del proyecto para sesiones futuras

## Qué es esto

Agente IA personal ("Juanito") conectado al WhatsApp del jefe via Baileys.
Escucha grupos pasivamente, responde cuando lo mencionan, y atiende DMs del jefe.
Vive en un VPS de DigitalOcean con IP fija (crítica para WA).

## Stack

- **Runtime:** Node.js ESM, sin transpilador
- **WhatsApp:** `@whiskeysockets/baileys` embebido directamente (no OpenWA, no Meta API)
- **IA:** `@anthropic-ai/sdk` — Claude con tool use
- **DB:** `better-sqlite3` — SQLite (mensajes, memoria, recordatorios, grupos, contactos)
- **Scheduler:** `cron` — recordatorios cada 1min, resúmenes cada 4h, limpieza 3am
- **Infra:** Docker + `entrypoint.sh` con backoff exponencial

## Arquitectura en runtime

```
Baileys (WebSocket a WA)
    │ messages.upsert event
    ▼
src/index.js → onMessage()
    ├── DM del jefe → handleBossMessage() → chat() → Claude → sendMessage()
    └── Grupo       → handleGroupMessage() → si mención → Claude → sendMessage()
                       └── siempre guarda en SQLite (lectura pasiva)
```

## Archivos clave

| Archivo | Rol |
|---|---|
| `src/whatsapp/index.js` | Baileys: connect, sendMessage, listGroups, getRecentMessages, resolveGroupByName |
| `src/index.js` | Entry point. Wira Baileys → bot handlers |
| `src/bot/index.js` | Router central. Dedup + autorización |
| `src/claude/index.js` | Claude: system prompt, tool use loop, reintentos, memoria |
| `src/db/index.js` | Todas las operaciones SQLite |
| `src/db/migrate.js` | Crea/actualiza tablas (idempotente) |
| `src/scheduler/reminders.js` | Cron: envía recordatorios vencidos |
| `src/scheduler/summaries.js` | Cron: resume grupos cada N horas |
| `entrypoint.sh` | Backoff exponencial entre crashes |

## Variables de entorno requeridas

```
ANTHROPIC_API_KEY   API key de Anthropic
BOSS_PHONE          Número del jefe sin +, ej: 573001234567
AGENT_PHONE         Número del bot con +, solo para primer vinculado
BOT_NAME            Nombre con que se menciona al bot (default: Juanito)
TZ                  Zona horaria (default: America/Bogota)
```

Ver `.env.example` para la lista completa.

## Estado del VPS (DigitalOcean SFO2, IP fija)

- Docker instalado y corriendo
- Este repo debe desplegarse aquí
- La IP fija es crítica — no migrar sin planificarlo
- Número del agente: SIM física, conecta via Baileys al arrancar

## Historia técnica importante

**Softban anterior:** el proceso crasheaba y el supervisor lo reiniciaba cada ~15s
sin backoff → loop rápido de reconexiones desde datacenter → WhatsApp lo detectó.
**Solución implementada:** `entrypoint.sh` con backoff 30→60→120→240→300s.
No tocar esta lógica sin entender las implicaciones.

## Pendientes (al cerrar la sesión de implementación)

### Bloqueantes para que funcione
1. Deploy en VPS: `git clone`, crear `.env`, `docker compose up -d --build`
2. Vincular WhatsApp: ver código en logs → ingresarlo en el teléfono físico
3. Agregar el bot a los grupos del jefe (manual, desde teléfono del jefe)

### Bug conocido
4. `handleGroupMessage` en `src/bot/index.js`: cuando mencionan al bot en un
   grupo, actualmente manda un DM al jefe en vez de responder en el grupo.
   Viene del diseño anterior de dos números. Corregir: cambiar `sendMessage(BOSS_PHONE(), ...)`
   por `sendMessage(chatId, ...)` para responder en el grupo.

### Personalización
5. System prompt en `src/claude/index.js:166` es genérico. Personalizar con:
   - Nombre y contexto del jefe
   - Grupos activos y su propósito
   - Proyectos en curso
6. Cargar contactos iniciales: `npm run contact -- "Nombre" "+57..."`

## Reglas de trabajo en este repo

- No tocar `entrypoint.sh` sin entender el contexto del softban
- No exponer puertos en docker-compose (Baileys es conexión saliente)
- No agregar dependencias sin justificación clara
- `src/db/migrate.js` es idempotente — seguro de correr múltiples veces
- Los tests usan `__setDeps()` en `src/claude/index.js` para inyectar mocks

## Cómo retomar una sesión

1. Leer este archivo
2. `git log --oneline -10` para ver el estado del repo
3. Revisar "Pendientes" de arriba para saber por dónde continuar
