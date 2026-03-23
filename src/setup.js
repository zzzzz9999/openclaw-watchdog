#!/usr/bin/env node
'use strict';

/**
 * setup.js — one-command installer for openclaw-watchdog
 *
 * Detects the current platform and installs the watchdog as a
 * background service that starts automatically on login/boot.
 *
 * Platforms:
 *   Windows  → Task Scheduler (no admin required)
 *   macOS    → launchd user agent
 *   Linux    → systemd user service
 *   WSL      → systemd user service + portproxy for health checks
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync, spawnSync } = require('child_process');

// ── Helpers ───────────────────────────────────────────────────────────────────

function detectPlatform() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  try {
    const v = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
    if (v.includes('microsoft') || v.includes('wsl')) return 'wsl';
  } catch (_) {}
  return 'linux';
}

const PLATFORM = detectPlatform();
const LOG_DIR  = path.join(os.homedir(), '.openclaw-watchdog');

// On Windows, if running from a UNC path (\\wsl$\...), convert to Windows path.
// Also find the Windows-native node.exe instead of the WSL one.
function toWinPath(p) {
  // Already a Windows path (C:\...)
  if (/^[A-Za-z]:\\/.test(p)) return p;
  // UNC WSL path: \\wsl$\Ubuntu\home\... or \\wsl.localhost\Ubuntu\home\...
  const uncMatch = p.match(/^[\\\/]{2}wsl[\$\.]?[\\\/\w]*?[\\\/]([^\\\/]+)(.*)/i);
  if (uncMatch) {
    // Convert via wsl.exe
    try {
      const wslPath = uncMatch[2].replace(/\\/g, '/');
      return execSync(`wsl -d ${uncMatch[1]} -- wslpath -w "${wslPath}"`, { stdio: 'pipe' })
        .toString().trim();
    } catch (_) {}
  }
  return p;
}

function findWindowsNode() {
  // If current node.exe is already a real Windows path, use it
  if (/^[A-Za-z]:\\/.test(process.execPath)) return process.execPath;
  // Otherwise find node.exe on the Windows PATH via where.exe
  try {
    const found = execSync('where.exe node.exe', { stdio: 'pipe' }).toString().trim().split('\n')[0].trim();
    if (found && /^[A-Za-z]:\\/.test(found)) return found;
  } catch (_) {}
  // Common install locations
  const candidates = [
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env.APPDATA || '', '..', 'Local', 'Programs', 'nodejs', 'node.exe'),
    'C:\\Program Files\\nodejs\\node.exe',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return 'node.exe';
}

const WATCHDOG = PLATFORM === 'windows'
  ? toWinPath(path.resolve(__dirname, 'watchdog.js'))
  : path.resolve(__dirname, 'watchdog.js');

const NODE = PLATFORM === 'windows' ? findWindowsNode() : process.execPath;

function info(m)  { console.log(`\x1b[32m[✓]\x1b[0m ${m}`); }
function warn(m)  { console.log(`\x1b[33m[!]\x1b[0m ${m}`); }
function error(m) { console.error(`\x1b[31m[✗]\x1b[0m ${m}`); }
function step(m)  { console.log(`\n\x1b[1m${m}\x1b[0m`); }

function run(cmd, opts = {}) {
  try {
    execSync(cmd, { stdio: 'inherit', ...opts });
    return true;
  } catch (e) {
    warn(`Command failed: ${cmd}`);
    return false;
  }
}

function runSilent(cmd) {
  try { execSync(cmd, { stdio: 'pipe' }); return true; } catch (_) { return false; }
}

// ── Windows — Task Scheduler ──────────────────────────────────────────────────

function setupWindows() {
  step('Installing for Windows via Task Scheduler...');

  const taskName = 'OpenClawWatchdog';
  const winTemp  = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
  const xmlPath  = path.join(winTemp, 'openclaw-watchdog.xml');

  // The watchdog script may live in WSL (\\wsl.localhost\...) which schtasks
  // cannot use as a working directory. Copy a small launcher .bat into %APPDATA%
  // that uses the UNC path — cmd.exe can run scripts via UNC even if it cannot
  // cd into them.
  const appData   = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const launcherDir = path.join(appData, 'openclaw-watchdog');
  const launcherPath = path.join(launcherDir, 'start.bat');
  const logPath   = path.join(appData, 'openclaw-watchdog', 'watchdog.log');

  fs.mkdirSync(launcherDir, { recursive: true });

  // Resolve openclaw command for the bat (same logic as watchdog.js findExecutable)
  const npmBin = path.join(appData, 'npm');
  let openclawCmd = 'openclaw';
  for (const c of [
    path.join(npmBin, 'openclaw.cmd'),
    path.join(npmBin, 'openclaw.ps1'),
    path.join(npmBin, 'openclaw'),
  ]) {
    try { if (fs.existsSync(c)) { openclawCmd = c; break; } } catch (_) {}
  }
  info(`openclaw : ${openclawCmd}`);

  // Build the launcher bat. Use the UNC watchdog path directly.
  const bat = `@echo off
"${NODE}" "${WATCHDOG}" --log-file "${logPath}"
`;
  fs.writeFileSync(launcherPath, bat);
  info(`Launcher written: ${launcherPath}`);
  info(`Node    : ${NODE}`);
  info(`Watchdog: ${WATCHDOG}`);

  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Keeps OpenClaw gateway alive during task execution</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${launcherPath}</Command>
      <WorkingDirectory>${launcherDir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;

  fs.writeFileSync(xmlPath, xml, 'utf8');

  if (run(`schtasks /Create /TN "${taskName}" /XML "${xmlPath}" /F`)) {
    info(`Task "${taskName}" registered`);
    run(`schtasks /Run /TN "${taskName}"`);
    info('Watchdog started');
    console.log('');
    info(`Stop  : schtasks /End /TN "${taskName}"`);
    info(`Remove: schtasks /Delete /TN "${taskName}" /F`);
    info(`Logs  : ${logPath}`);
  } else {
    error('Failed to register task. Try running PowerShell as Administrator.');
    process.exit(1);
  }
}

// ── macOS — launchd ───────────────────────────────────────────────────────────

function setupMacos() {
  step('Installing for macOS via launchd...');

  const agentDir  = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(agentDir, 'com.openclaw.watchdog.plist');

  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(LOG_DIR,  { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.openclaw.watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${WATCHDOG}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_DIR}/stdout.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>`;

  // Unload first if already installed
  runSilent(`launchctl unload "${plistPath}" 2>/dev/null`);
  fs.writeFileSync(plistPath, plist);

  if (run(`launchctl load -w "${plistPath}"`)) {
    info('Watchdog loaded via launchd');
    console.log('');
    info(`Stop  : launchctl unload "${plistPath}"`);
    info(`Start : launchctl load -w "${plistPath}"`);
    info(`Logs  : tail -f ${LOG_DIR}/stdout.log`);
  } else {
    error('launchctl failed. Try running manually:');
    error(`  launchctl load -w "${plistPath}"`);
    process.exit(1);
  }
}

// ── Linux / WSL — systemd user service ───────────────────────────────────────

function setupSystemd(label) {
  const serviceDir  = path.join(os.homedir(), '.config', 'systemd', 'user');
  const servicePath = path.join(serviceDir, 'openclaw-watchdog.service');

  fs.mkdirSync(serviceDir, { recursive: true });
  fs.mkdirSync(LOG_DIR,    { recursive: true });

  const unit = `[Unit]
Description=OpenClaw Watchdog — keeps OpenClaw gateway alive
After=network.target

[Service]
Type=simple
ExecStart=${NODE} ${WATCHDOG}
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;

  fs.writeFileSync(servicePath, unit);
  info(`Service file written: ${servicePath}`);

  const ok =
    run('systemctl --user daemon-reload') &&
    run('systemctl --user enable openclaw-watchdog') &&
    run('systemctl --user start openclaw-watchdog');

  if (ok) {
    info(`${label} service enabled and started`);
    console.log('');
    info('Status : systemctl --user status openclaw-watchdog');
    info('Stop   : systemctl --user stop openclaw-watchdog');
    info('Logs   : journalctl --user -u openclaw-watchdog -f');
  } else {
    error('systemctl failed. Run manually:');
    error('  systemctl --user daemon-reload');
    error('  systemctl --user enable openclaw-watchdog');
    error('  systemctl --user start openclaw-watchdog');
    process.exit(1);
  }
}

// ── WSL — systemd + portproxy setup ──────────────────────────────────────────

function setupWSL() {
  step('Installing for WSL...');

  // 1. Get Windows host IP
  let hostIP = null;
  try {
    const out = execSync('ip route show default').toString();
    const m   = out.match(/default via ([\d.]+)/);
    if (m) hostIP = m[1];
  } catch (_) {}

  if (hostIP) {
    info(`Windows host IP: ${hostIP}`);

    // 2. Set up portproxy so WSL can reach Windows 127.0.0.1:18789
    step('Setting up Windows portproxy (may prompt for admin)...');
    const proxyCmd = `cmd.exe /c "netsh interface portproxy add v4tov4 listenport=18789 listenaddress=${hostIP} connectport=18789 connectaddress=127.0.0.1"`;
    if (runSilent(proxyCmd)) {
      info(`Portproxy added: ${hostIP}:18789 → 127.0.0.1:18789`);
    } else {
      warn('Portproxy setup failed (may need admin). Health checks may not work.');
      warn('Run in PowerShell (Admin):');
      warn(`  netsh interface portproxy add v4tov4 listenport=18789 listenaddress=${hostIP} connectport=18789 connectaddress=127.0.0.1`);
    }

    // 3. Add Windows Firewall rule
    const fwCmd = `cmd.exe /c "netsh advfirewall firewall add rule name=\\"OpenClaw Gateway WSL\\" dir=in action=allow protocol=TCP localport=18789"`;
    if (runSilent(fwCmd)) {
      info('Windows Firewall rule added for port 18789');
    } else {
      warn('Firewall rule setup failed (may need admin). Add manually in PowerShell (Admin):');
      warn('  New-NetFirewallRule -DisplayName "OpenClaw Gateway WSL" -Direction Inbound -Protocol TCP -LocalPort 18789 -Action Allow');
    }
  } else {
    warn('Could not detect Windows host IP. Health checks will use 127.0.0.1.');
  }

  // 4. Install systemd service
  step('Installing systemd user service...');
  setupSystemd('WSL');

  // 5. Print Windows auto-start instructions
  const distro = process.env.WSL_DISTRO_NAME || 'Ubuntu';
  console.log('');
  step('Optional: auto-start on Windows boot');
  warn('Run this in PowerShell to start WSL watchdog when Windows boots:');
  console.log(`
  $action  = New-ScheduledTaskAction -Execute 'wsl.exe' \`
               -Argument '-d ${distro} -- bash -lc "systemctl --user start openclaw-watchdog"'
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0
  Register-ScheduledTask -TaskName 'OpenClawWatchdogWSL' \`
    -Action $action -Trigger $trigger -Settings $settings -Force
  `);
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n\x1b[1m openclaw-watchdog setup\x1b[0m');
console.log(`Platform detected: \x1b[36m${PLATFORM}\x1b[0m\n`);

switch (PLATFORM) {
  case 'windows': setupWindows(); break;
  case 'macos':   setupMacos();   break;
  case 'linux':   step('Installing for Linux via systemd...'); setupSystemd('Linux'); break;
  case 'wsl':     setupWSL();     break;
}

console.log('\n\x1b[1m\x1b[32mSetup complete.\x1b[0m\n');
