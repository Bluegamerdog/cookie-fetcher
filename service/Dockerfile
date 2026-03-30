# Use official Node 20 image (Debian Bookworm base)
FROM node:20-bookworm

# Create working directory
WORKDIR /home/container

# Copy package files first to leverage Docker layer caching
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy remaining source files
COPY . .

# Run the script
CMD ["npm", "run", "start"]
