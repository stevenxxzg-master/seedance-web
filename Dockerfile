FROM node:22-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY server.js index.html index-zh.html ./
EXPOSE 10100
CMD ["node", "server.js"]
