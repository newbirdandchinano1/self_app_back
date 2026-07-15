#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo
echo "========== 数据库自动备份安装 =========="
echo

read -p "请输入数据库备份仓库路径： " BACKUP_REPO

read -p "请输入 Docker MySQL 容器名称 [my_mysql]： " CONTAINER_NAME
CONTAINER_NAME=${CONTAINER_NAME:-my_mysql}

read -p "请输入数据库名称 [self_app]： " DB_NAME
DB_NAME=${DB_NAME:-self_app}

read -p "请输入数据库用户名 [root]： " DB_USER
DB_USER=${DB_USER:-root}

read -s -p "请输入数据库密码： " DB_PASS
echo

read -p "请输入 Git 分支 [main]： " BRANCH
BRANCH=${BRANCH:-main}

cat > "$SCRIPT_DIR/backup.conf" <<EOF
BACKUP_REPO="$BACKUP_REPO"
CONTAINER_NAME="$CONTAINER_NAME"
DB_NAME="$DB_NAME"
DB_USER="$DB_USER"
DB_PASS="$DB_PASS"
BRANCH="$BRANCH"
EOF

chmod 600 "$SCRIPT_DIR/backup.conf"
chmod +x "$SCRIPT_DIR/backup.sh"

CRON_JOB="0 2 * * * $SCRIPT_DIR/backup.sh >> $SCRIPT_DIR/backup.log 2>&1"

(
crontab -l 2>/dev/null | grep -v "$SCRIPT_DIR/backup.sh"
echo "$CRON_JOB"
) | crontab -

echo
echo "======================================"
echo "✅ 安装完成"
echo "配置文件：$SCRIPT_DIR/backup.conf"
echo "定时任务：每天凌晨 2 点"
echo "======================================"