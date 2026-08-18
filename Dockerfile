FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git jq python3 python3-venv ripgrep tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force
COPY --from=build /app/dist ./dist

RUN mkdir -p /data/workspace /data/sessions /data/state /data/pi-agent \
  && chown -R node:node /data

ENV NODE_ENV=production
ENV PRAX_DATA_DIR=/data

USER node
ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/main.js"]
