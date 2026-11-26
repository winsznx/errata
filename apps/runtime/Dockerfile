FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/runtime/package.json apps/runtime/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @errata/runtime...
COPY apps/runtime apps/runtime
RUN pnpm --filter @errata/runtime build \
 && pnpm --filter @errata/runtime deploy --prod --legacy /out \
 && cp -r apps/runtime/dist apps/runtime/drizzle /out/

FROM node:24-alpine
ENV NODE_ENV=production DATASETS_DIR=/srv/datasets SOURCE_CACHE_DIR=/srv/storage/sources EXPORT_STORAGE_DIR=/srv/storage/exports RUNTIME_HOST=0.0.0.0 RUNTIME_PORT=4000
WORKDIR /srv/app
COPY --from=build /out ./
COPY datasets /srv/datasets
RUN mkdir -p /srv/storage && chown -R node:node /srv/storage
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:4000/api/v1/health || exit 1
CMD ["node", "dist/main.js"]
