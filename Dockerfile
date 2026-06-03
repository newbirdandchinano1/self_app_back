FROM swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:18-alpine

WORKDIR /app

# 设置国内镜像源
RUN npm config set registry https://registry.npmmirror.com

# 先复制依赖文件并安装
COPY package*.json ./
RUN npm install --no-package-lock

# 暴露端口
EXPOSE 3000

# 【核心变动】启动开发模式（热重载）
CMD ["npm", "run", "dev"]