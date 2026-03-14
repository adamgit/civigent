# ── Build everything ─────────────────────────────────
FROM node:20-alpine AS build
RUN apk add --no-cache git
WORKDIR /src

# Install dependencies for all three packages
COPY package*.json ./
COPY packages/milkdown-serializer/package*.json packages/milkdown-serializer/
COPY backend/package*.json backend/
COPY frontend/package*.json frontend/

RUN cd packages/milkdown-serializer && npm install \
 && cd ../../backend && npm install \
 && cd ../frontend && npm install

# Copy source and build in dependency order
COPY packages/milkdown-serializer packages/milkdown-serializer
RUN cd packages/milkdown-serializer && npm run build

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
COPY --from=build /src/packages/milkdown-serializer /app/packages/milkdown-serializer
RUN npm install --omit=dev

# Backend compiled output
COPY --from=build /src/backend/dist ./dist

# Frontend static files — served by Express in production
COPY --from=build /src/frontend/dist ./public

EXPOSE 3000
CMD ["node", "dist/server.js"]
