# 官方 Jenkins LTS 镜像本身不含 Docker CLI，需在构建阶段安装 CLI + Compose plugin。
# 运行时通过挂载 /var/run/docker.sock 使用宿主机 Docker，无需 privileged / DinD。
FROM jenkins/jenkins:lts-jdk17

USER root

# --- Docker CLI（静态二进制，仅客户端；与当前 Jenkins 容器实际版本对齐）---
ARG DOCKER_VERSION=29.3.1
RUN curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" \
    | tar -xz --strip-components=1 -C /usr/local/bin docker/docker \
  && chmod +x /usr/local/bin/docker \
  && docker --version

# --- Docker Compose V2 plugin（与宿主机已验证版本对齐）---
ARG COMPOSE_VERSION=v2.32.1
RUN mkdir -p /usr/local/lib/docker/cli-plugins \
  && curl -fsSL "https://ghproxy.net/https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
       -o /usr/local/lib/docker/cli-plugins/docker-compose \
  && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose \
  && docker compose version

# 让 jenkins 用户能访问宿主机 docker.sock（GID 需与宿主机 docker 组一致，可构建时覆盖）
ARG DOCKER_GID=999
RUN if getent group "${DOCKER_GID}" >/dev/null; then \
      usermod -aG "$(getent group "${DOCKER_GID}" | cut -d: -f1)" jenkins; \
    else \
      groupadd -g "${DOCKER_GID}" docker && usermod -aG docker jenkins; \
    fi

USER jenkins
