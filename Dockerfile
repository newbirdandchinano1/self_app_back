# 使用轻量级镜像
FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# 生产运行镜像
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY public ./public

EXPOSE 3000

CMD ["node", "dist/index.js"]
