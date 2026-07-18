# Franke relay — самодостаточный образ «слепой трубы».
# Relay не видит содержимого: пересылает только E2E-зашифрованные блобы.
FROM node:22-alpine

WORKDIR /app

# Ставим зависимости отдельным слоем (кэшируется, пока не менялся package.json).
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./

ENV PORT=1234
EXPOSE 1234

# Журнал шифрокомнат живёт на диске и переживает рестарт контейнера
# (примонтируйте volume на /data).
RUN mkdir -p /data && chown node:node /data
ENV DATA_DIR=/data

# Порт > 1024 — non-root справится.
USER node

# Healthcheck бьёт в /health (busybox wget есть в alpine).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O- "http://localhost:${PORT}/health" || exit 1

CMD ["node", "server.js"]
