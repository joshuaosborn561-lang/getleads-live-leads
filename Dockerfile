FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
COPY sql ./sql

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "src/index.js"]
