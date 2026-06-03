FROM swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:18-alpine

WORKDIR /app

# 设置国内镜像源
RUN npm config set registry https://registry.npmmirror.com

# 先复制依赖文件并安装（含 devDependencies，用于 tsc 编译）
COPY package*.json ./
RUN npm install --no-package-lock

# 复制源码并编译 TypeScript -> dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 编译完成后移除 devDependencies，减小镜像体积
RUN npm prune --production

EXPOSE 3000

CMD ["npm", "start"]
