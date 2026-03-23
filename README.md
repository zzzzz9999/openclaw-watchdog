# openclaw-watchdog

OpenClaw 在执行技能/任务时有时会意外退出，导致聊天工具无法连接。这个工具解决这个问题。

**原理**：作为守护进程运行，监控 OpenClaw 进程，崩溃时自动重启，并通过 TCP 健康检查检测进程假死。

---

## 快速开始

### 安装

```bash
git clone https://github.com/zzzzz9999/openclaw-watchdog.git
cd openclaw-watchdog
npm install
```

### 直接运行（前台）

```bash
node src/watchdog.js
```

这会启动 OpenClaw（`openclaw gateway`），并在它崩溃时自动重启。

### 安装为系统服务（推荐，开机自启）

```bash
node src/install-service.js
```

- **Linux**：注册为 systemd 用户服务
- **macOS**：注册为 launchd 用户 Agent

---

## 工作原理

```
┌─────────────────────────────────────────────┐
│              openclaw-watchdog               │
│                                              │
│   spawn()  ──────────────►  openclaw         │
│                               gateway        │
│   health check (TCP :18789)                  │
│   every 10s                                  │
│                                              │
│   on exit/crash ──► wait 2s ──► restart      │
│   (指数退避，最长 30s)                         │
└─────────────────────────────────────────────┘
```

1. **进程监控**：通过 `child_process.spawn` 管理 OpenClaw 进程，监听 `exit` 事件
2. **健康检查**：每 10 秒 TCP 连接 `127.0.0.1:18789`，端口无响应则强制重启
3. **指数退避**：崩溃后等待 2s → 4s → 8s ... 最长 30s，避免快速循环崩溃
4. **优雅关闭**：收到 `SIGTERM`/`SIGINT` 时，先发 SIGTERM 给 OpenClaw，5 秒后强制 SIGKILL

---

## 选项

```
node src/watchdog.js [选项]

选项：
  -c, --command <cmd>         启动命令 (默认: openclaw)
  -a, --args <args>           命令参数 (默认: gateway)
  -p, --port <port>           健康检查端口 (默认: 18789)
  --max-restarts <n>          最大重启次数，0=不限 (默认: 0)
  --restart-delay <ms>        初始重启延迟 (默认: 2000)
  --max-delay <ms>            最大重启延迟 (默认: 30000)
  --health-interval <ms>      健康检查间隔 (默认: 10000)
  --health-timeout <ms>       健康检查超时 (默认: 3000)
  --log-file <path>           日志文件路径 (默认: ~/.openclaw-watchdog/watchdog.log)
  --no-log-file               只输出到控制台
```

### 示例

```bash
# 自定义端口
node src/watchdog.js --port 19000

# 最多重启 5 次后放弃
node src/watchdog.js --max-restarts 5

# 使用非默认的 openclaw 路径
node src/watchdog.js --command /usr/local/bin/openclaw --args "gateway --verbose"
```

---

## 查看日志

```bash
# 实时查看 watchdog 日志
tail -f ~/.openclaw-watchdog/watchdog.log

# Linux systemd 服务日志
journalctl --user -u openclaw-watchdog -f

# macOS launchd 日志
tail -f ~/.openclaw-watchdog/stdout.log
```

---

## 管理服务

### Linux (systemd)

```bash
systemctl --user status openclaw-watchdog   # 查看状态
systemctl --user stop openclaw-watchdog     # 停止
systemctl --user restart openclaw-watchdog  # 重启
systemctl --user disable openclaw-watchdog  # 取消开机自启
```

### macOS (launchd)

```bash
launchctl list | grep openclaw              # 查看状态
launchctl stop com.openclaw.watchdog        # 停止
launchctl unload ~/Library/LaunchAgents/com.openclaw.watchdog.plist  # 卸载
```

---

## 要求

- Node.js 18+
- 已安装并配置好 OpenClaw（`openclaw` 命令可用）

---

## License

MIT
