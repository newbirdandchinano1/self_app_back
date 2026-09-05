pipeline {
    agent any

    // GitHub Webhook 触发（推送仍走 GitHub；拉代码走国内镜像）
    // Job → Pipeline → SCM 的 Repository URL 须与 GIT_REPO_URL 一致（镜像地址）
    // 勾选：GitHub hook trigger for GITScm polling
    triggers {
        githubPush()
    }

    environment {
        // Jenkins 与业务跑在同一台机器，直接本机部署
        DEPLOY_DIR = '/root/self_app_back'
        // 国内 GitHub 镜像。失效可换：
        // https://gh-proxy.com/https://github.com/newbirdandchinano1/self_app_back.git
        // https://gitclone.com/github.com/newbirdandchinano1/self_app_back.git
        GIT_REPO_URL = 'https://ghproxy.net/https://github.com/newbirdandchinano1/self_app_back.git'
    }

    stages {
        stage('1. 拉取源码') {
            steps {
                echo "👉 经国内镜像拉取代码: ${GIT_REPO_URL}"
                checkout([
                    $class: 'GitSCM',
                    branches: [[name: '*/master']],
                    extensions: [[
                        $class: 'CloneOption',
                        shallow: true,
                        depth: 1,
                        noTags: true,
                        timeout: 20
                    ]],
                    userRemoteConfigs: [[
                        credentialsId: 'github-token',
                        url: "${GIT_REPO_URL}"
                    ]]
                ])
            }
        }

        stage('2. 同步到部署目录') {
            steps {
                echo "👉 同步工作区到 ${DEPLOY_DIR}（保留已有 .env）..."
                sh '''
                mkdir -p "$DEPLOY_DIR"

                if [ -f "$DEPLOY_DIR/.env" ]; then
                  cp "$DEPLOY_DIR/.env" /tmp/self_app_back.env.bak
                fi

                tar --exclude='.git' \
                    --exclude='node_modules' \
                    --exclude='dist' \
                    --exclude='source.tar.gz' \
                    -cf - . | tar -xf - -C "$DEPLOY_DIR"

                if [ -f /tmp/self_app_back.env.bak ]; then
                  mv /tmp/self_app_back.env.bak "$DEPLOY_DIR/.env"
                fi
                '''
            }
        }

        stage('3. docker compose 部署') {
            steps {
                echo '👉 本机 docker compose 构建并启动...'
                dir("${DEPLOY_DIR}") {
                    sh 'docker compose up -d --build'
                }
            }
        }

        stage('4. 健康检查') {
            steps {
                echo '👉 检查 node-app 是否就绪...'
                sh '''
                for i in 1 2 3 4 5 6 7 8 9 10; do
                  if docker exec my_node_app wget -qO- http://127.0.0.1:3000/ >/dev/null 2>&1 \
                     || curl -fsS http://127.0.0.1:3000/ >/dev/null 2>&1; then
                    echo '健康检查通过'
                    exit 0
                  fi
                  echo "等待服务启动... ($i/10)"
                  sleep 6
                done
                echo '健康检查失败，最近日志：'
                docker logs --tail 80 my_node_app || true
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
