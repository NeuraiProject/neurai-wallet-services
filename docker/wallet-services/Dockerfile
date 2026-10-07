# Build from the repository root: docker build -f docker/wallet-services/Dockerfile .
FROM node:22-slim
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
COPY docker/wallet-services/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 19020
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
