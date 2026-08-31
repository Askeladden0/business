# Byggetrinn: better-sqlite3 er et nativt tillegg og trenger verktøykjede.
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Kjøretrinn: kun det ferdige resultatet, ingen kompilator.
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data && chown node:node /data

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

USER node
EXPOSE 8080

# Ingen egen helsesjekk her; Fly kaller /healthz utenfra (se fly.toml).
CMD ["node", "src/index.js"]
