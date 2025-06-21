# Dockerfile
FROM node:22-slim

# 1. Install canvas’s native deps
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libcairo2-dev \
      libpango1.0-dev \
      libjpeg-dev \
      libgif-dev \
      librsvg2-dev && \
    rm -rf /var/lib/apt/lists/*

# 2. Copy and install your app
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci

# 3. Bundle the rest of your source
COPY . .

# 4. Listen on the App Platform port
ENV PORT  $PORT
CMD ["node", "api.js"]