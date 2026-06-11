FROM node:20-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY package-lock.json ./
COPY prisma ./prisma
RUN npm install
RUN npx prisma generate

COPY server.js ./
COPY media-planner-rakuten-gateway.html ./
COPY usage.html ./

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["npm", "start"]
