FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

RUN chown -R node:node /app

ENV NODE_ENV=production
EXPOSE 4000

# Run as the non-root 'node' user (built into the official image) instead of root —
# limits blast radius if the process is ever compromised via a dependency vuln etc.
USER node

# No VOLUME needed anymore — all data (including uploaded images) lives in Postgres
# (DATABASE_URL, e.g. Neon), not on local disk, so the container itself is fully
# stateless and safe to redeploy/scale/restart at any time.
CMD ["node", "server.js"]
