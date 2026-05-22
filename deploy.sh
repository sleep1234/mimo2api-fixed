#!/bin/bash
# mimo2api-fix 部署脚本
# 用法: bash deploy.sh [目标目录]
# 默认目标: /vol1/1000/9自己的软件项目/小米中继

set -e

TARGET_DIR="${1:-/vol1/1000/9自己的软件项目/小米中继}"
PORT=4003
CONTAINER_NAME="mimo2api-fix"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== mimo2api-fix 部署 ==="
echo "目标目录: $TARGET_DIR"
echo "端口: $PORT"
echo ""

# 1. 创建目标目录
mkdir -p "$TARGET_DIR"
mkdir -p "$TARGET_DIR/data"
mkdir -p "$TARGET_DIR/logs"

# 2. 复制项目文件
echo "[1/5] 复制项目文件..."
rsync -a --exclude='node_modules' --exclude='.git' --exclude='dist' --exclude='logs/*.json' "$SCRIPT_DIR/" "$TARGET_DIR/"

# 3. 安装依赖并构建
echo "[2/5] 安装依赖..."
cd "$TARGET_DIR"
npm install --production=false 2>&1 | tail -3

echo "[3/5] 构建 TypeScript..."
npx tsc 2>&1
echo "BUILD OK"

# 4. 清理开发依赖
npm prune --production 2>&1 | tail -2

# 5. 创建启动脚本
echo "[4/5] 创建启动脚本..."
cat > "$TARGET_DIR/start.sh" << 'STARTEOF'
#!/bin/bash
cd "$(dirname "$0")"
export PORT=4003
node dist/index.js
STARTEOF
chmod +x "$TARGET_DIR/start.sh"

# 6. 创建 systemd 服务文件（如果 systemd 可用）
echo "[5/5] 配置服务..."
if command -v systemctl &>/dev/null; then
  cat > /etc/systemd/system/mimo2api-fix.service << SVCEOF
[Unit]
Description=MiMo API Proxy (mimo2api-fix)
After=network.target

[Service]
Type=simple
WorkingDirectory=$TARGET_DIR
ExecStart=$(which node) dist/index.js
Restart=on-failure
RestartSec=5
Environment=PORT=4003
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SVCEOF

  systemctl daemon-reload
  systemctl enable mimo2api-fix 2>/dev/null
  systemctl restart mimo2api-fix
  echo "✅ systemd 服务已启动"
  systemctl status mimo2api-fix --no-pager -l | head -10
else
  echo "⚠️  systemd 不可用，请手动启动:"
  echo "  cd $TARGET_DIR && bash start.sh"
fi

echo ""
echo "=== 部署完成 ==="
echo "服务地址: http://$(hostname -I | awk '{print $1}'):$PORT"
echo "管理面板: http://$(hostname -I | awk '{print $1}'):$PORT/"
echo "默认密码: admin"
