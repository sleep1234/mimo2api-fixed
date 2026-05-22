FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npx tsc

RUN npm prune --production

EXPOSE 4003

ENV PORT=4003
ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
