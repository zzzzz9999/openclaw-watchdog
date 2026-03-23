#!/usr/bin/env node
'use strict';

/**
 * install-service.js
 *
 * Installs openclaw-watchdog as a system service so it starts automatically
 * on boot and restarts if it crashes.
 *
 * Supports:
 *   - Linux (systemd user service)
 *   - macOS (launchd user agent)
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

const platform   = os.platform();
const watchdogBin = path.resolve(__dirname, 'watchdog.js');
const nodeBin    = process.execPath;

function info(msg)  { console.log(`[INFO]  ${msg}`); }
function error(msg) { console.error(`[ERROR] ${msg}`); }

// ── systemd (Linux) ───────────────────────────────────────────────────────────

function installSystemd() {
  const serviceDir  = path.join(os.homedir(), '.config', 'systemd', 'user');
  const servicePath = path.join(serviceDir, 'openclaw-watchdog.service');

  fs.mkdirSync(serviceDir, { recursive: true });

  const unit = `[Unit]
Description=OpenClaw Watchdog — keeps OpenClaw alive during task execution
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} ${watchdogBin}
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;

  fs.writeFileSync(servicePath, unit);
  info(`Wrote service file: ${servicePath}`);

  try {
    execSync('systemctl --user daemon-reload');
    execSync('systemctl --user enable openclaw-watchdog');
    execSync('systemctl --user start openclaw-watchdog');
    info('Service enabled and started via systemd');
    info('Check status: systemctl --user status openclaw-watchdog');
    info('View logs:    journalctl --user -u openclaw-watchdog -f');
  } catch (e) {
    error(`systemctl command failed: ${e.message}`);
    info(`You can manually run:\n  systemctl --user daemon-reload\n  systemctl --user enable openclaw-watchdog\n  systemctl --user start openclaw-watchdog`);
  }
}

// ── launchd (macOS) ───────────────────────────────────────────────────────────

function installLaunchd() {
  const agentDir  = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(agentDir, 'com.openclaw.watchdog.plist');
  const logDir    = path.join(os.homedir(), '.openclaw-watchdog');

  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(logDir,   { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.openclaw.watchdog</string>

    <key>ProgramArguments</key>
    <array>
        <string>${nodeBin}</string>
        <string>${watchdogBin}</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${logDir}/stdout.log</string>

    <key>StandardErrorPath</key>
    <string>${logDir}/stderr.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    </dict>
</dict>
</plist>
`;

  fs.writeFileSync(plistPath, plist);
  info(`Wrote plist: ${plistPath}`);

  try {
    execSync(`launchctl load -w "${plistPath}"`);
    info('Service loaded via launchd');
    info(`Check status: launchctl list | grep openclaw`);
    info(`View logs:    tail -f ${logDir}/stdout.log`);
  } catch (e) {
    error(`launchctl failed: ${e.message}`);
    info(`Manually run: launchctl load -w "${plistPath}"`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

info(`Detected platform: ${platform}`);

if (platform === 'linux') {
  installSystemd();
} else if (platform === 'darwin') {
  installLaunchd();
} else {
  error(`Unsupported platform: ${platform}`);
  info('On Windows, use Task Scheduler or NSSM to run: node ' + watchdogBin);
  process.exit(1);
}
