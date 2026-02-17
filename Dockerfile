# Phantom Protocol Relayer - deploy to Koyeb, Fly.io, etc. (no credit card)
FROM node:20-slim

WORKDIR /app

# Copy backend and circuits
COPY backend/package.json backend/
COPY backend/src backend/src/
COPY circuits circuits/

# Install backend deps (better-sqlite3 builds native bindings)
WORKDIR /app/backend
RUN npm install --omit=dev

WORKDIR /app
ENV PORT=8080
EXPOSE 8080
CMD ["node", "backend/src/index.js"]
