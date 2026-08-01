FROM node:20-bookworm AS build
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/docs ./docs
COPY --from=build /app/frontstation-worker ./frontstation-worker

ENV NODE_ENV=production
ENV PORT=3000
# 前站 encoder 默认：compose 内由 docker-compose 注入 worker URL；单容器可覆盖
ENV KGM_FRONTSTATION_MODE=auto
ENV KGM_FRONTSTATION_PREFER_ONNX=0
ENV KGM_FRONTSTATION_ONNX_MODEL=Xenova/all-MiniLM-L6-v2
ENV KGM_FRONTSTATION_TIMEOUT_MS=8000
ENV KGM_FRONTSTATION_SUMMARY_MODE=local
ENV TRANSFORMERS_CACHE=/home/kgm/.cache/huggingface

RUN useradd --create-home --shell /bin/bash kgm \
  && mkdir -p /home/kgm/.cache/huggingface \
  && chown -R kgm:kgm /app /home/kgm
USER kgm

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "dist/server/start.js"]
