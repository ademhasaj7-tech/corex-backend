FROM node:22-bookworm-slim

# Hosted bots may install native Node modules (like better-sqlite3), which
# require a compiler toolchain. Node 22 also matches the Supabase packages
# used by many modern bot projects.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (separate layer) so rebuilds are fast when
# only your code changes, not your package.json.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# Persisted data — mount a volume here on whatever host you use (Railway
# Volumes, Docker -v, etc.) so bots and account data survive a rebuild.
RUN mkdir -p /app/data /app/bots /app/tmp

EXPOSE 4000
CMD ["node", "server.js"]
