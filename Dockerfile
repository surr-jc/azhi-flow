# Azhi server image. Workers run natively on Linux hosts with `azhi worker start`.
# A registry mirror can be used when Docker Hub rate-limits pulls (AZHI_NODE_IMAGE in compose).
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production AZHI_HOST=0.0.0.0 AZHI_DATA_DIR=/data
COPY package.json package-lock.json ./
# The server never runs OpenCode (workers do), so its optional binary is left out of the image.
RUN npm ci --omit=dev --ignore-scripts=false && rm -rf node_modules/opencode-ai node_modules/opencode-linux-* && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY migrations ./migrations
# `azhi init` templates; the CLI in the image reads them at start-up.
COPY examples ./examples
COPY tsconfig.json ./
VOLUME /data
EXPOSE 7400
ENTRYPOINT ["node", "bin/azhi.js"]
CMD ["server", "start"]
