# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS frontend-build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html vite.config.js jsconfig.json tailwind.config.js postcss.config.js ./
COPY src ./src
RUN npm run build

FROM nginx:1.27-alpine AS frontend
COPY --from=frontend-build /app/dist /usr/share/nginx/html
# SPA 路由回退 + /api 反向代理（SSE 流式需关闭缓冲），见 docker/nginx.conf
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

FROM node:22-bookworm-slim AS backend
ENV NODE_ENV=production
ENV HOST=0.0.0.0
WORKDIR /app/server
# better-sqlite3 的 prebuild 二进制托管在 GitHub，网络不稳时下载超时，
# 预装编译工具链保证可回退源码编译
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY server/package*.json ./
RUN npm install --omit=dev --no-package-lock
COPY server ./
EXPOSE 3000
CMD ["node", "index.js"]
