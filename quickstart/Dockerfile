# ── Build everything ─────────────────────────────────
FROM node:24-alpine AS build
RUN apk add --no-cache git
WORKDIR /src
ARG BUILD_SHA=dev
ARG BUILD_DATE=1970-01-01T00:00:00Z

# Install dependencies for all three packages
COPY package*.json ./
COPY sharedlibs/milkdown-serializer/package*.json sharedlibs/milkdown-serializer/
COPY sharedlibs/shared-types/package*.json sharedlibs/shared-types/
COPY backend/package*.json backend/
COPY frontend/package*.json frontend/

RUN cd sharedlibs/milkdown-serializer && npm install \
 && cd ../shared-types && npm install \
 && cd ../../backend && npm install \
 && cd ../frontend && npm install

# Shared tsconfig needed by all sub-projects
COPY tsconfig.base.json ./

# Copy source and build in dependency order
COPY sharedlibs sharedlibs
RUN cd sharedlibs/milkdown-serializer && npm run build \
 && cd ../shared-types && npm run build

COPY backend backend
RUN cd backend && npm run build
COPY package.json ./package.json
RUN echo "{\"version\":\"$(node -p "require('./package.json').version")\",\"sha\":\"${BUILD_SHA}\",\"date\":\"${BUILD_DATE}\"}" > backend/dist/build-info.json

COPY frontend frontend
ENV BUILD_SHA="${BUILD_SHA}"
ENV BUILD_DATE="${BUILD_DATE}"
RUN cd frontend && npm run build

# ── Production image ────────────────────────────────
FROM node:24-alpine AS prod
RUN apk add --no-cache git su-exec ripgrep
WORKDIR /app

# Backend production deps
COPY --from=build /src/backend/package*.json ./
# Must be at ../sharedlibs relative to /app to match the file: dependency path
COPY --from=build /src/sharedlibs/milkdown-serializer /sharedlibs/milkdown-serializer
# Dev package.json points main at src/index.ts — fix for compiled runtime
RUN sed -i 's|"main": "src/index.ts"|"main": "dist/index.js"|' /sharedlibs/milkdown-serializer/package.json
RUN npm install --omit=dev

# Backend compiled output (tsc mirrors monorepo structure: dist/backend/src/ + dist/sharedlibs/)
COPY --from=build /src/backend/dist ./dist

# Frontend static files — served by Express in production
COPY --from=build /src/frontend/dist ./public

COPY quickstart/entrypoint.sh /entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
