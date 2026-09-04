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
EXPOSE 80

FROM node:22-bookworm-slim AS backend
ENV NODE_ENV=production
ENV HOST=0.0.0.0
WORKDIR /app/server
COPY server/package*.json ./
RUN npm install --omit=dev --no-package-lock
COPY server ./
EXPOSE 3000
CMD ["node", "index.js"]
