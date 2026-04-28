FROM node:22-alpine
RUN apk add --no-cache ffmpeg python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY server.js db.js index.html index-zh.html ./
COPY static ./static
EXPOSE 10100
CMD ["node", "server.js"]
