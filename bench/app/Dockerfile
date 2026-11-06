# The benchmark app, built from this repo's own source. Build from the repo root:
#   docker build -f bench/app/Dockerfile -t rate-limiter-bench .
# Pinned so every results file can name the exact Node version it ran on.
FROM node:22.23.4-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22.23.4-alpine
WORKDIR /app
ENV NODE_ENV=production
# Dev dependencies stay: ioredis and yaml are dev dependencies of the library, and the app needs
# both. Image size doesn't matter for benchmarks.
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY bench/app ./bench/app
COPY bench/rules ./bench/rules
USER node
EXPOSE 3000
# Node strips the types itself, as `npm run example` does. The package name resolves to ./dist.
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "bench/app/server.ts"]
