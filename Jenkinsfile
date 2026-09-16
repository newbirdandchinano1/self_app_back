pipeline {
    agent any

    // GitHub Webhook 触发（推送仍走 GitHub；拉代码走国内镜像）
    // Job → Pipeline → SCM 的 Repository URL 须与 GIT_REPO_URL 一致（镜像地址）
    // 勾选：GitHub hook trigger for GITScm polling
    //
    // 重要：Jenkins 以 Docker 运行时，/var/jenkins_home 是 named volume，
    // 宿主机路径与容器内路径不是同一目录；docker run -v 挂载的是宿主机路径。
    // 因此部署目录必须使用宿主机 bind mount（见 jenkins/docker-compose.yml）。
    triggers {
        githubPush()
    }

    environment {
        // 宿主机与 Jenkins 容器共用的 bind mount 目录（两边路径一致）
        DEPLOY_DIR = '/opt/self_app_back'
        // 国内 GitHub 镜像。失效可换：
        // https://gh-proxy.com/https://github.com/newbirdandchinano1/self_app_back.git
        // https://gitclone.com/github.com/newbirdandchinano1/self_app_back.git
        GIT_REPO_URL = 'https://ghproxy.net/https://github.com/newbirdandchinano1/self_app_back.git'
    }

    stages {
        // 不设「拉取源码」阶段：Declarative Pipeline 已由 Job SCM 自动 Checkout
        // （日志中的 Declarative: Checkout SCM）。Job Repository URL 须为 ghproxy 地址。

        stage('1. 同步到部署目录') {
            steps {
                echo "👉 将 WORKSPACE 同步到 ${DEPLOY_DIR}（保留已有 .env）..."
                sh '''
                set -e

                echo "===== 同步诊断 ====="
                echo "pwd          = $(pwd)"
                echo "WORKSPACE    = ${WORKSPACE}"
                echo "DEPLOY_DIR   = ${DEPLOY_DIR}"
                echo "----- 源目录 ls -lah (WORKSPACE) -----"
                ls -lah "${WORKSPACE}"
                echo "----- 目标目录同步前 -----"
                mkdir -p "${DEPLOY_DIR}"
                ls -lah "${DEPLOY_DIR}" || true

                if [ ! -d "${WORKSPACE}" ]; then
                  echo "错误: WORKSPACE 不存在: ${WORKSPACE}"
                  exit 1
                fi

                # 保留已有 .env，清空旧代码后重新同步
                ENV_BAK="/tmp/self_app_back.env.bak.$$"
                if [ -f "${DEPLOY_DIR}/.env" ]; then
                  cp -a "${DEPLOY_DIR}/.env" "${ENV_BAK}"
                  echo "已备份 ${DEPLOY_DIR}/.env -> ${ENV_BAK}"
                else
                  rm -f "${ENV_BAK}"
                  echo "目标目录尚无 .env，跳过备份"
                fi

                find "${DEPLOY_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

                # 明确从 WORKSPACE 打包，不依赖当前 shell 的 .
                tar --exclude='./.git' \
                    --exclude='./node_modules' \
                    --exclude='./dist' \
                    --exclude='./source.tar.gz' \
                    -C "${WORKSPACE}" \
                    -cf - . | tar -xf - -C "${DEPLOY_DIR}"

                if [ -f "${ENV_BAK}" ]; then
                  mv "${ENV_BAK}" "${DEPLOY_DIR}/.env"
                  echo "已还原 .env"
                fi

                echo "----- 目标目录同步后 -----"
                ls -lah "${DEPLOY_DIR}"

                COMPOSE_FILE=""
                if [ -f "${DEPLOY_DIR}/docker-compose.yml" ]; then
                  COMPOSE_FILE="docker-compose.yml"
                elif [ -f "${DEPLOY_DIR}/compose.yml" ]; then
                  COMPOSE_FILE="compose.yml"
                else
                  echo "错误: 部署目录中找不到 docker-compose.yml / compose.yml"
                  echo "DEPLOY_DIR 内容："
                  ls -lah "${DEPLOY_DIR}" || true
                  echo "WORKSPACE 内容："
                  ls -lah "${WORKSPACE}" || true
                  exit 1
                fi
                echo "检测到 Compose 文件: ${DEPLOY_DIR}/${COMPOSE_FILE}"
                '''
            }
        }

        stage('2. docker compose 部署') {
            steps {
                echo '👉 经 Docker Socket 构建并启动...'
                sh '''
                set -e
                cd "${DEPLOY_DIR}"

                if [ -f docker-compose.yml ]; then
                  COMPOSE_FILE="docker-compose.yml"
                elif [ -f compose.yml ]; then
                  COMPOSE_FILE="compose.yml"
                else
                  echo "错误: 找不到 Compose 配置文件"
                  ls -lah "${DEPLOY_DIR}" || true
                  exit 1
                fi

                echo "使用 Compose 文件: -f ${COMPOSE_FILE}"
                echo "DEPLOY_DIR=${DEPLOY_DIR} (须为宿主机 bind mount，见 jenkins/docker-compose.yml)"

                run_compose() {
                  # $1 = 子命令及参数，例如: config / up -d --build
                  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
                    docker compose -f "${COMPOSE_FILE}" "$@"
                  elif command -v docker-compose >/dev/null 2>&1; then
                    docker-compose -f "${COMPOSE_FILE}" "$@"
                  elif command -v docker >/dev/null 2>&1; then
                    echo "未检测到 compose 插件，改用 docker:27-cli..."
                    docker run --rm \
                      -v /var/run/docker.sock:/var/run/docker.sock \
                      -v "${DEPLOY_DIR}:${DEPLOY_DIR}" \
                      -w "${DEPLOY_DIR}" \
                      docker:27-cli \
                      compose -f "${COMPOSE_FILE}" "$@"
                  else
                    echo "错误: Jenkins 容器内找不到 docker CLI。"
                    echo "请用仓库 jenkins/Dockerfile 构建 my-jenkins:lts，并确保挂载："
                    echo "  - /var/run/docker.sock:/var/run/docker.sock"
                    echo "  - /opt/self_app_back:/opt/self_app_back"
                    exit 1
                  fi
                }

                echo "----- docker compose config 校验 -----"
                run_compose config

                echo "----- docker compose up -d --build -----"
                run_compose up -d --build
                '''
            }
        }

        stage('3. 健康检查') {
            steps {
                echo '👉 检查 node-app 是否就绪...'
                sh '''
                set -e
                for i in 1 2 3 4 5 6 7 8 9 10; do
                  if { command -v docker >/dev/null 2>&1 && docker exec my_node_app wget -qO- http://127.0.0.1:3000/ >/dev/null 2>&1; } \
                     || curl -fsS http://127.0.0.1:3000/ >/dev/null 2>&1; then
                    echo '健康检查通过'
                    exit 0
                  fi
                  echo "等待服务启动... ($i/10)"
                  sleep 6
                done
                echo '健康检查失败，最近日志：'
                if command -v docker >/dev/null 2>&1; then
                  docker logs --tail 80 my_node_app || true
                fi
                exit 1
                '''
                echo '🎉 部署完成'
            }
        }
    }

    post {
        failure {
            echo '❌ 流水线失败，请查看日志'
        }
    }
}
