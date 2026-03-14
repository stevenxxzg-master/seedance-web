FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY server.js index.html ./
EXPOSE 3456
CMD ["node", "server.js"]
