# ── Base ──────────────────────────────────────────────
FROM node:24-alpine AS base
WORKDIR /app

# ── Dev target ────────────────────────────────────────
FROM base AS dev
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host"]

# ── Build target ──────────────────────────────────────
FROM base AS build
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# ── Production target ─────────────────────────────────
FROM nginx:alpine AS prod
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
