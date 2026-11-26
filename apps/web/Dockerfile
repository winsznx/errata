FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/runtime/package.json apps/runtime/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @errata/web...
COPY apps/web apps/web
ARG RUNTIME_INTERNAL_URL=http://runtime:4000
ARG NEXT_PUBLIC_REPO_URL
ENV NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1 RUNTIME_INTERNAL_URL=$RUNTIME_INTERNAL_URL NEXT_PUBLIC_REPO_URL=$NEXT_PUBLIC_REPO_URL
RUN pnpm --filter @errata/web build

FROM node:24-alpine
ARG RUNTIME_INTERNAL_URL=http://runtime:4000
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 RUNTIME_INTERNAL_URL=$RUNTIME_INTERNAL_URL
WORKDIR /srv/web
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
