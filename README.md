# openclaw-watchdog

自动守护 OpenClaw gateway 进程。崩溃后立即重启，支持健康检查、指数退避、开机自启。

支持平台：**Windows · macOS · Linux · WSL**

---

## 快速开始

### 前置要求

- [Node.js](https://nodejs.org) v18 或更高版本
- 已安装 [OpenClaw](https://openclaw.ai)

### 安装

```bash
git clone https://github.com/zzzzz9999/openclaw-watchdog.git
cd openclaw-watchdog
npm install
```

---

## 各平台使用方法

### Windows（推荐：注册为开机自启任务）

在 **PowerShell** 中运行：

```powershell
cd openclaw-watchdog
node src/setup.js
```

setup 会自动：
1. 注册 Task Scheduler 任务，登录后自动启动 watchdog
2. 立即启动 watchdog

手动管理：
```powershell
# 停止
schtasks /End /TN "OpenClawWatchdog"

# 启动
schtasks /Run /TN "OpenClawWatchdog"

# 卸载
schtasks /Delete /TN "OpenClawWatchdog" /F
```

日志路径：`%USERPROFILE%\.openclaw-watchdog\watchdog.log`

---

### macOS（推荐：注册为 launchd 用户服务）

```bash
node src/setup.js
```

setup 会自动：
1. 写入 `~/Library/LaunchAgents/com.openclaw.watchdog.plist`
2. 通过 launchd 加载，登录后自动启动

手动管理：
```bash
# 停止
launchctl unload ~/Library/LaunchAgents/com.openclaw.watchdog.plist

# 启动
launchctl load -w ~/Library/LaunchAgents/com.openclaw.watchdog.plist

# 查看日志
tail -f ~/.openclaw-watchdog/stdout.log
```

---

### Linux（推荐：注册为 systemd 用户服务）

```bash
node src/setup.js
```

setup 会自动：
1. 写入 `~/.config/systemd/user/openclaw-watchdog.service`
2. 通过 systemd 启动并设置开机自启

手动管理：
```bash
# 状态
systemctl --user status openclaw-watchdog

# 停止
systemctl --user stop openclaw-watchdog

# 查看日志
journalctl --user -u openclaw-watchdog -f
```

---

### WSL（Windows Subsystem for Linux）

WSL 下 setup 会自动完成以下所有步骤：

```bash
node src/setup.js
```

自动处理：
1. 检测 Windows 宿主机 IP
2. 添加 `netsh portproxy`，将 `宿主机IP:18789 → 127.0.0.1:18789`（让 WSL 能健康检查 Windows 侧的 gateway）
3. 添加 Windows 防火墙规则放行 18789 端口
4. 注册 systemd 用户服务

> **portproxy 和防火墙规则需要管理员权限。** 如果自动设置失败，setup 会打印手动执行的命令。

**开机自启（可选）**：setup 完成后会打印一段 PowerShell 命令，在 Windows 侧注册 Task Scheduler 任务，Windows 启动时自动拉起 WSL watchdog。

---

## 直接运行（不安装服务）

任何平台都可以直接运行，关闭终端后停止：

```bash
node src/watchdog.js
```

---

## 配置选项

```
选项                        默认值                                    说明
--port <n>                 18789                                     监控的 gateway 端口
--restart-delay <ms>       2000                                      首次重启等待时间
--max-delay <ms>           30000                                     最大重启等待（指数退避上限）
--max-restarts <n>         0                                         最大重启次数，0 = 不限
--health-interval <ms>     10000                                     健康检查间隔
--health-timeout <ms>      3000                                      健康检查超时
--log-file <path>          ~/.openclaw-watchdog/watchdog.log         日志路径
--no-log-file                                                        禁用文件日志
```

示例：

```bash
# 最多重启 10 次，重启间隔从 1 秒开始
node src/watchdog.js --max-restarts 10 --restart-delay 1000

# 不写日志文件，只输出到控制台
node src/watchdog.js --no-log-file
```

---

## 工作原理

```
watchdog 启动
    └─ 启动 openclaw gateway 子进程
         └─ 每 10 秒 TCP 连接 127.0.0.1:18789 做健康检查
              ├─ 连接成功 → 继续监控
              └─ 连接失败 → SIGKILL 子进程 → 等待退避延迟 → 重新启动
```

- **崩溃重启**：子进程任何原因退出都会触发重启
- **冻结检测**：进程存在但端口无响应时，强制 kill 后重启
- **指数退避**：连续失败时重启间隔翻倍（2s → 4s → 8s → ... 上限 30s）
- **优雅停止**：向 watchdog 发送 SIGTERM/SIGINT 时，先 SIGTERM 子进程，5 秒后强制 SIGKILL

---

## 卸载

**Windows：**
```powershell
schtasks /Delete /TN "OpenClawWatchdog" /F
```

**macOS：**
```bash
launchctl unload ~/Library/LaunchAgents/com.openclaw.watchdog.plist
rm ~/Library/LaunchAgents/com.openclaw.watchdog.plist
```

**Linux / WSL：**
```bash
systemctl --user stop openclaw-watchdog
systemctl --user disable openclaw-watchdog
rm ~/.config/systemd/user/openclaw-watchdog.service
systemctl --user daemon-reload
```

**WSL 额外清理（portproxy / 防火墙）：**
```powershell
# PowerShell (Admin)
netsh interface portproxy delete v4tov4 listenport=18789 listenaddress=<宿主机IP>
Remove-NetFirewallRule -DisplayName "OpenClaw Gateway WSL"
```
