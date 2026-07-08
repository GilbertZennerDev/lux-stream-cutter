FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

RUN apk add --no-cache ffmpeg

ENV NODE_ENV=production

CMD ["node", "src/index.mjs"]
