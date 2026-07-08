FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

RUN apk add --no-cache ffmpeg

ENV NODE_ENV=production
# Cap V8 heap so segment buffering can't balloon and OOM-kill the VM.
ENV NODE_OPTIONS="--max-old-space-size=1024"

CMD ["node", "src/index.mjs"]
