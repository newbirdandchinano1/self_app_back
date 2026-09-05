pipeline {
    agent any

    // GitHub Webhook 触发（推送仍走 GitHub；拉代码走国内镜像）
    // Jenkins Job 还需勾选：Build Triggers → GitHub hook trigger for GITScm polling
    // 【重要】Job → Pipeline → SCM 的 Repository URL 也必须改成下面的镜像地址，
    // 否则读取 Jenkinsfile 时仍会直连 GitHub 失败。
    triggers {
        githubPush()
    }

    environment {
        SERVER_CREDENTIAL_ID = 'github-token'
        SERVER_IP = '124.223.161.79'
        DEPLOY_DIR = '/root/self_app_back'
        // 国内 GitHub 镜像（前缀代理）。失效可换：
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

        stage('2. 打包并上传到部署机') {
            steps {
                echo '👉 打包源码并 SCP 到远程...'
                sh '''
                tar --exclude='.git' \
                    --exclude='node_modules' \
                    --exclude='dist' \
                    --exclude='source.tar.gz' \
                    -czf /tmp/source.tar.gz .
                mv /tmp/source.tar.gz .
                '''

                withCredentials([usernamePassword(
                    credentialsId: "${SERVER_CREDENTIAL_ID}",
                    usernameVariable: 'USER',
                    passwordVariable: 'SERVER_PASS'
                )]) {
                    sh '''
                    sshpass -p "$SERVER_PASS" ssh -o StrictHostKeyChecking=no "$USER"@"$SERVER_IP" "mkdir -p $DEPLOY_DIR"
                    sshpass -p "$SERVER_PASS" scp -o StrictHostKeyChecking=no source.tar.gz "$USER"@"$SERVER_IP":"$DEPLOY_DIR"/
                    '''
                }
            }
        }

        stage('3. 远程 docker compose 部署') {
            steps {
                echo '👉 远程解压并用 docker compose 构建启动...'
                withCredentials([usernamePassword(
                    credentialsId: "${SERVER_CREDENTIAL_ID}",
                    usernameVariable: 'USER',
                    passwordVariable: 'SERVER_PASS'
                )]) {
                    sh '''
                    sshpass -p "$SERVER_PASS" ssh -o StrictHostKeyChecking=no "$USER"@"$SERVER_IP" "
                        set -e
                        cd $DEPLOY_DIR

                        # 若服务器上已有 .env，解压时先备份，避免被覆盖
                        if [ -f .env ]; then cp .env .env.bak; fi

                        tar -xzf source.tar.gz

                        if [ -f .env.bak ]; then mv .env.bak .env; fi

                        docker compose up -d --build

                        rm -f source.tar.gz
                    "
                    '''
                }
            }
        }

        stage('4. 健康检查') {
            steps {
                echo '👉 检查 node-app 是否就绪...'
                withCredentials([usernamePassword(
                    credentialsId: "${SERVER_CREDENTIAL_ID}",
                    usernameVariable: 'USER',
                    passwordVariable: 'SERVER_PASS'
                )]) {
                    sh '''
                    sshpass -p "$SERVER_PASS" ssh -o StrictHostKeyChecking=no "$USER"@"$SERVER_IP" "
                        for i in 1 2 3 4 5 6 7 8 9 10; do
                          if docker exec my_node_app wget -qO- http://127.0.0.1:3000/ >/dev/null 2>&1 \\
                             || curl -fsS http://127.0.0.1:3000/ >/dev/null 2>&1; then
                            echo '健康检查通过'
                            exit 0
                          fi
                          echo \"等待服务启动... (\$i/10)\"
                          sleep 6
                        done
                        echo '健康检查失败，最近日志：'
                        docker logs --tail 80 my_node_app || true
                        exit 1
                    "
                    '''
                }
                echo '🎉 部署完成'
            }
        }
    }

    post {
        always {
            sh 'rm -f source.tar.gz || true'
        }
        failure {
            echo '❌ 流水线失败，请查看日志'
        }
    }
}
