FROM node:24-alpine AS dependencies
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/matching/package.json packages/matching/package.json
COPY packages/normalization/package.json packages/normalization/package.json
RUN npm ci --no-audit --no-fund

FROM dependencies AS production-dependencies
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
    && npm ci --omit=dev --omit=optional --legacy-peer-deps --ignore-scripts --no-audit --no-fund

FROM dependencies AS build
COPY . .
RUN cp .env.example .env \
    && npm run prisma:generate \
    && npm run build \
    && rm .env

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/matching/package.json packages/matching/package.json
COPY packages/normalization/package.json packages/normalization/package.json
COPY --from=production-dependencies /app/node_modules node_modules
COPY --from=production-dependencies /app/apps apps
COPY --from=production-dependencies /app/packages packages

COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/packages/config/dist packages/config/dist
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/packages/database/dist packages/database/dist
COPY --from=build /app/packages/matching/dist packages/matching/dist
COPY --from=build /app/packages/normalization/dist packages/normalization/dist

USER node
CMD ["npm", "run", "start:api"]
