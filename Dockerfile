FROM node:20-slim

WORKDIR /app

# Install build deps for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --production

COPY . .

# Create data directory for SQLite
RUN mkdir -p /app/data

ENV DATABASE_PATH=/app/data/tcg-bot.db
ENV NODE_ENV=production

CMD ["node", "src/index.js"]
