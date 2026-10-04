# Azhi server image. Workers run natively on Linux hosts with `azhi worker start`.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production AZHI_HOST=0.0.0.0 AZHI_DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts=false && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY migrations ./migrations
COPY tsconfig.json ./
VOLUME /data
EXPOSE 7400
ENTRYPOINT ["node", "bin/azhi.js"]
CMD ["server", "start"]
