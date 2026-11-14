# Build context is the repo root: docker build -f server/Dockerfile .
# Used by docker-compose.yml locally and by Easypanel on the VPS. One image: API + web app (/app/).

FROM node:22-alpine AS web
WORKDIR /build
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY web/package.json web/
RUN npm pkg delete scripts.prepare && npm ci --workspace web --workspace packages/shared --include-workspace-root=false
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY web web
RUN npm run build -w web

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
# The root "prepare" script installs git hooks; it has no place in the image.
RUN npm pkg delete scripts.prepare \
  && npm ci --workspace server --workspace packages/shared --include-workspace-root=false --omit=dev
COPY packages/shared packages/shared
COPY db db
COPY server server
COPY --from=web /build/web/dist web/dist
# Folder for developer page captures (a private volume on the server, see docker-compose.prod.yml).
RUN mkdir -p /captures && chown node:node /captures
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
ENTRYPOINT ["server/docker-entrypoint.sh"]
