# ── Base ──────────────────────────────────────────────
FROM node:24-alpine AS base
RUN apk add --no-cache git ripgrep
WORKDIR /app

# ── Dev target ────────────────────────────────────────
FROM base AS dev
# Dev dependencies (nodemon, etc.) installed via mount
CMD ["npm", "run", "dev"]

# ── Build target ──────────────────────────────────────
FROM base AS build
ARG BUILD_SHA=dev
ARG BUILD_DATE=1970-01-01T00:00:00Z
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build \
 && echo "{\"version\":\"$(node -p "require('./package.json').version")\",\"sha\":\"${BUILD_SHA}\",\"date\":\"${BUILD_DATE}\"}" > dist/build-info.json

# ── Production target ─────────────────────────────────
FROM base AS prod
COPY --from=build /app/package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/server.js"]
