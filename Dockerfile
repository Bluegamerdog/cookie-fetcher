# Use official Node 20 image (Debian Bullseye base)
FROM node:20-bullseye

# Install Chromium dependencies required by Puppeteer
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2t64 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1 \
    lsb-release \
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Create working directory
WORKDIR /home/container

# Copy package files first to leverage Docker layer caching
COPY package*.json ./

# Install dependencies (Puppeteer will auto-install Chromium unless you skip it)
RUN npm ci

# Copy remaining source files
COPY . .

# Set environment variables for Puppeteer (helps in CI/CD or Cloud Run)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false \
    PUPPETEER_CACHE_DIR=/home/container/.cache/puppeteer

# Run the script
CMD ["npm", "run", "fetch"]
