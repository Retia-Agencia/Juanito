# Dockerfile — build multi-stage para compilar better-sqlite3 nativo

# ===== Stage 1: Builder (con herramientas de compilación) =====
FROM node:22-slim AS builder

WORKDIR /app

# better-sqlite3 necesita compilarse desde fuente
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
# Usar npm install (no ci) porque no versionamos package-lock.json
RUN npm install --omit=dev

# ===== Stage 2: Producción (imagen limpia) =====
FROM node:22-slim AS production

WORKDIR /app

# Copiar node_modules ya compilados
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/

# Crear directorio de datos
RUN mkdir -p /app/data

ENV NODE_ENV=production

# Migrar y arrancar
CMD ["sh", "-c", "node src/db/migrate.js && node src/index.js"]
