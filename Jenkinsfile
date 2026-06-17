pipeline {
    agent any
    triggers {
        // 如果想改成每 2 分钟检查一次，可以换成 'H/2 * * * *'
        pollSCM('H/3 * * * *')
    }
    environment {
        // 远程服务器凭据ID
        SERVER_CREDENTIAL_ID = 'yun-server'
        SERVER_IP = '1.14.76.59'
        
        // 远程部署的目标目录
        DEPLOY_DIR = '/opt/self_app'
    }

    stages {
        stage('1. 拉取源码') {
            steps {
                echo '👉 开始从 Gitee 仓库拉取最新代码...'
                deleteDir()
                git(
                    branch: 'master', 
                    url: 'https://gitee.com/zhen1594834072/self_app_back.git',
                    credentialsId: 'gitee-auth'
                )
            }
        }

        stage('2. 打包源码并传输到远程') {
            steps {
                echo '👉 压缩所有源码文件并上传到远程服务器...'
                sh '''
                # 1. 把压缩包生成在系统的 /tmp 临时目录下，彻底避免套娃冲突
                tar --exclude='.git' -czf /tmp/source.tar.gz .
                
                # 2. 打包完成后，把压缩包移动回当前目录，供后面的 scp 命令传输
                mv /tmp/source.tar.gz .
                '''
                
                withCredentials([usernamePassword(credentialsId: "${SERVER_CREDENTIAL_ID}", usernameVariable: 'USER', passwordVariable: 'SERVER_PASS')]) {
                    sh '''
                    # 确保远程目录存在，然后传过去
                    sshpass -p "$SERVER_PASS" ssh -o StrictHostKeyChecking=no "$USER"@"$SERVER_IP" "mkdir -p $DEPLOY_DIR"
                    sshpass -p "$SERVER_PASS" scp -o StrictHostKeyChecking=no source.tar.gz "$USER"@"$SERVER_IP":"$DEPLOY_DIR"/
                    '''
                }
            }
        }

        stage('3. 远程构建镜像并启动') {
            steps {
                echo '👉 远程服务器解压源码，并使用 docker-compose 构建并启动服务...'
                withCredentials([usernamePassword(credentialsId: "${SERVER_CREDENTIAL_ID}", usernameVariable: 'USER', passwordVariable: 'SERVER_PASS')]) {
                    sh '''
                    sshpass -p "$SERVER_PASS" ssh -o StrictHostKeyChecking=no "$USER"@"$SERVER_IP" "
                        cd $DEPLOY_DIR && \\
                        
                        # 1. 解压源码
                        tar -xzf source.tar.gz && \\
                        
                        # 2. 停止并强制清理可能遗留的同名旧容器
                        docker compose down || true && \\
                        docker rm -f my_mysql || true && \\
                        docker rm -f my_node_app || true && \\
                        
                        # 3. 重新构建镜像并后台启动容器
                        docker compose up -d --build && \\
                        
                        # 4. 搞定后，清理掉源码压缩包，保持服务器干净
                        rm -f source.tar.gz
                    "
                    '''
                }
                echo '🎉 全自动 Docker 部署彻底完成！'
            }
        }
    }

    post {
        always {
            echo '清理 Jenkins 本地产生的临时压缩包...'
            sh 'rm -f source.tar.gz || true'
        }
        failure {
            echo '❌ 流水线执行失败！请检查日志。'
        }
    }
}