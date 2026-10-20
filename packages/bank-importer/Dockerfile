# Build from the repository root:
#   docker build -f packages/bank-importer/Dockerfile -t actual-bank-importer .
FROM node:22-bookworm AS builder

WORKDIR /app

COPY .yarn ./.yarn
COPY yarn.lock package.json .yarnrc.yml tsconfig.json lage.config.js ./
COPY packages/ ./packages/

RUN yarn install

ENV NODE_OPTIONS=--max_old_space_size=8192

# The API bundles loot-core from this repo, so imports use the same
# (customised) reconciliation logic as the server and web app.
# (Not `yarn build:api`: lage needs git, which is not in the build context.)
RUN yarn workspace @actual-app/crdt build
RUN yarn workspace @actual-app/api exec vite build
RUN yarn workspace @actual-app/bank-importer build

# Assemble a minimal runtime: the importer bundle, the API bundle and the
# API's one native dependency.
RUN mkdir -p /out \
    && echo '{"name":"bank-importer-runtime","private":true,"type":"module"}' > /out/package.json \
    && cd /out \
    && npm install --no-save --no-package-lock --omit=dev \
       "better-sqlite3@$(node -p "require('/app/packages/api/package.json').dependencies['better-sqlite3']")" \
    && mkdir -p /out/node_modules/@actual-app/api \
    && cp -r /app/packages/api/dist /app/packages/api/package.json /out/node_modules/@actual-app/api/ \
    && cp -r /app/packages/bank-importer/dist /out/dist

FROM node:22-bookworm-slim AS prod

RUN apt-get update && apt-get install -y tini && apt-get clean -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
ENV BANK_IMPORTER_CONFIG=/import/config.json

COPY --from=builder /out /app

VOLUME /import
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "node", "/app/dist/index.js"]
CMD ["run", "--watch", "300"]
