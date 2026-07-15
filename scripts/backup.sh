#!/bin/bash

#############################################
# MySQL(Docker) 自动备份 + 自动提交 Gitee
#############################################

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

CONFIG_FILE="$SCRIPT_DIR/backup.conf"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "❌ 找不到配置文件：$CONFIG_FILE"
    echo "请先执行 install_backup.sh"
    exit 1
fi

source "$CONFIG_FILE"

BACKUP_FILE="$BACKUP_REPO/backup.sql"

echo "========================================"
echo "开始时间：$(date '+%F %T')"

if [ ! -d "$BACKUP_REPO/.git" ]; then
    echo "❌ 找不到 Git 仓库：$BACKUP_REPO"
    exit 1
fi

cd "$BACKUP_REPO" || exit 1

echo "正在备份数据库..."

docker exec "$CONTAINER_NAME" sh -c \
"mysqldump -u${DB_USER} -p'${DB_PASS}' --single-transaction --default-character-set=utf8mb4 ${DB_NAME}" \
> "$BACKUP_FILE"

if [ $? -ne 0 ]; then
    echo "❌ 数据库备份失败"
    exit 1
fi

echo "✅ 数据库备份成功"

git add backup.sql

if git diff --cached --quiet; then
    echo "数据库没有变化，无需提交。"
    exit 0
fi

echo "发现数据库变化，提交到 Gitee..."

git commit -m "Auto Backup $(date '+%Y-%m-%d %H:%M:%S')"

if [ $? -ne 0 ]; then
    echo "❌ Git Commit 失败"
    exit 1
fi

git push origin "$BRANCH"

if [ $? -ne 0 ]; then
    echo "❌ Git Push 失败"
    exit 1
fi

echo "✅ 上传成功"

echo "结束时间：$(date '+%F %T')"
echo "========================================"