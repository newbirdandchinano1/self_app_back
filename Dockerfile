FROM swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:18-alpine AS builder

WORKDIR /app

RUN apk add --no-cache tzdata \
  && npm config set registry https://registry.npmmirror.com

ENV TZ=Asia/Shanghai

COPY package*.json ./
RUN npm install --no-package-lock

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:18-alpine

WORKDIR /app

RUN apk add --no-cache tzdata \
  && npm config set registry https://registry.npmmirror.com

ENV TZ=Asia/Shanghai

COPY package*.json ./
RUN npm install --omit=dev --no-package-lock

COPY --from=builder /app/dist ./dist
COPY public ./public

EXPOSE 3000

CMD ["node", "dist/index.js"]
