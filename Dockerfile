FROM node:20-slim

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY media-planner-rakuten-gateway.html ./

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["npm", "start"]
