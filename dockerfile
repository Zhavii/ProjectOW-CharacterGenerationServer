FROM node:22-slim

# 1. Install native and build-tool deps for canvas
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        libcairo2-dev \
        libpango1.0-dev \
        libjpeg-dev \
        libgif-dev \
        librsvg2-dev && \
    rm -rf /var/lib/apt/lists/*

# 2. Set your workdir, copy package files, install deps
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci

# 3. Copy the rest of your code (including app/)
COPY . .

# 4. Tell Node to run your real entrypoint
ENV PORT $PORT
CMD ["node", "app/app.js"]
