# OpenClaw Gateway Monitor

自动监控 openclaw gateway 状态，关闭后自动重启。支持 Windows、macOS、Linux、WSL。

## 快速开始

### Linux / macOS / WSL
```bash
chmod +x start.sh
./start.sh
```

### Windows（双击运行）
- `start.bat` — 命令提示符（CMD）
- `start.ps1` — PowerShell（右键 → 用 PowerShell 运行）

### 直接用 Node.js
```bash
node monitor.js
```

## 环境变量配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENCLAW_PORT` | `18789` | Gateway 监听端口 |
| `CHECK_INTERVAL` | `5000` | 检查间隔（毫秒） |
| `RESTART_DELAY` | `2000` | 检测到宕机后等待重启的时间（毫秒） |
| `MAX_RESTARTS` | `0` | 最大重启次数，0 = 无限制 |
| `GATEWAY_ARGS` | `--port 18789 --verbose` | 传给 `openclaw gateway` 的参数 |

示例：
```bash
OPENCLAW_PORT=18789 CHECK_INTERVAL=3000 ./start.sh
```

## 工作原理

1. 每 5 秒尝试连接 `127.0.0.1:18789`
2. 如果连接失败，等待 2 秒后执行 `openclaw gateway --port 18789 --verbose`
3. 捕获 gateway 进程的输出并显示
4. 按 Ctrl+C 退出监控并停止 gateway

## 前提条件

- Node.js 18+
- openclaw 已全局安装：`npm install -g openclaw@latest`
