# Агентский сервер Kaiten на своём хосте. Сборка — из корня репозитория:
#   docker build -f deploy/agent-server/Dockerfile -t kaiten-agent .
# Настройки — переменные окружения (deploy/agent-server/.env.example), данные — том /data.

FROM node:24.14-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts/build-agent-server.mjs scripts/
COPY src ./src
RUN node scripts/build-agent-server.mjs /out/agent-server.mjs

FROM node:24.14-alpine
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
WORKDIR /app
COPY --from=build /out/agent-server.mjs ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO /dev/null http://127.0.0.1:8787/ || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "agent-server.mjs"]
