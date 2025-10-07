FROM node:20-slim

# Install puppeteer dependencies
RUN apt-get update && apt-get install -y \
    wget curl gnupg ca-certificates \
    fonts-liberation libnss3 libx11-xcb1 libxcomposite1 libxcursor1 \
    libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libgbm1 libpangocairo-1.0-0 \
    libpango-1.0-0 libcups2 libatk1.0-0 libatk-bridge2.0-0 libasound2 libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package.json / package-lock.json first for caching
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy script
COPY . .

# Environment variables should be passed at runtime
ENV ROBLOX_USER=""
ENV ROBLOX_PASS=""

CMD ["node", "fetch-cookie.js"]
