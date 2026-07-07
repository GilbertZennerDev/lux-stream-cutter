FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

# No deps — pure Node built-ins (fetch, crypto).
ENV NODE_ENV=production

CMD ["node", "src/index.mjs"]
