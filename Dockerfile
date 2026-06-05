# Dockerfile — build multi-stage para compilar better-sqlite3 nativo

# ===== Stage 1: Builder =====
FROM node:22-alpine AS builder

WORKDIR /app

# better-sqlite3 necesita compilarse desde fuente en Alpine (musl)
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

# ===== Stage 2: Producción =====
FROM node:22-alpine AS production

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/
COPY entrypoint.sh ./entrypoint.sh

RUN mkdir -p /app/data && chmod +x /app/entrypoint.sh

ENV NODE_ENV=production

CMD ["/app/entrypoint.sh"]
