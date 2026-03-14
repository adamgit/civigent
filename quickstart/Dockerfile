# ── Build everything ─────────────────────────────────
FROM node:20-alpine AS build
RUN apk add --no-cache git
WORKDIR /src

# Install dependencies for all three packages
COPY package*.json ./
COPY sharedlibs/milkdown-serializer/package*.json sharedlibs/milkdown-serializer/
COPY backend/package*.json backend/
COPY frontend/package*.json frontend/

RUN cd sharedlibs/milkdown-serializer && npm install \
 && cd ../../backend && npm install \
 && cd ../frontend && npm install

# Shared tsconfig needed by all sub-projects
COPY tsconfig.base.json ./

# Copy source and build in dependency order
COPY sharedlibs/milkdown-serializer sharedlibs/milkdown-serializer
RUN cd sharedlibs/milkdown-serializer && npm run build

COPY backend backend
RUN cd backend && npm run build

COPY frontend frontend
RUN cd frontend && npm run build

# ── Production image ────────────────────────────────
FROM node:20-alpine AS prod
RUN apk add --no-cache git
WORKDIR /app

# Backend production deps
COPY --from=build /src/backend/package*.json ./
# Must be at ../sharedlibs relative to /app to match the file: dependency path
COPY --from=build /src/sharedlibs/milkdown-serializer /sharedlibs/milkdown-serializer
RUN npm install --omit=dev

# Backend compiled output
COPY --from=build /src/backend/dist ./dist

# Frontend static files — served by Express in production
COPY --from=build /src/frontend/dist ./public

EXPOSE 3000
CMD ["node", "dist/server.js"]
