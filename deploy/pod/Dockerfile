# Azhi Flow in one container, for a small proof of concept (docs/pod-poc.md): `azhi up` with the
# embedded database (PGlite) and Temporal's single-binary dev server, state under /data, and no
# execution worker. Teams run workers on their own machines. Not the production setup
# (docs/install.md): one database writer, and the Temporal dev server is not built for production.
#
#   docker build -f deploy/pod/Dockerfile -t azhi-flow/pod .
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS web
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY web ./web
RUN npm run build:web

FROM ${NODE_IMAGE}
WORKDIR /app
COPY package.json package-lock.json ./
# Workers run harnesses; this container never does, so OpenCode is left out.
RUN npm ci --omit=dev --ignore-scripts=false && rm -rf node_modules/opencode-ai node_modules/opencode-linux-* && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY --from=web /build/src/web/dist ./src/web/dist
COPY migrations ./migrations
COPY examples ./examples
COPY tsconfig.json ./
# The pinned, checksum-verified Temporal CLI, fetched at build time so the pod needs no download at start.
RUN node --import tsx --input-type=module -e "const { ensureTemporalCli } = await import('./src/local/temporal.ts'); const bin = await ensureTemporalCli('/tmp/temporal'); (await import('node:fs')).copyFileSync(bin, '/usr/local/bin/temporal');" \
  && chmod 755 /usr/local/bin/temporal && rm -rf /tmp/temporal && temporal --version

ENV NODE_ENV=production AZHI_HOME=/data AZHI_HOST=0.0.0.0 AZHI_PORT=7400 AZHI_TEMPORAL_PORT=7233 \
    NODE_OPTIONS=--max-old-space-size=768
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 7400 7233
ENTRYPOINT ["node", "bin/azhi.js"]
CMD ["up", "--no-worker"]
