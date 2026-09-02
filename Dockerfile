# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 – build: install every dependency and compile TypeScript to JS
# ---------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json tsconfig.json tsconfig.build.json ./
RUN npm install --no-audit --no-fund

COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 – runtime: production dependencies + compiled output only
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=builder /app/dist ./dist

EXPOSE 3000

# Container-level health probe (Docker Compose declares its own as well).
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node

CMD ["node", "dist/server.js"]
