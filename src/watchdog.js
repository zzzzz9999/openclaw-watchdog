#!/usr/bin/env node
'use strict';

/**
 * openclaw-watchdog v2
 *
 * Cross-platform watchdog for OpenClaw gateway.
 * Supports: Windows · macOS · Linux · WSL
 *
 * Usage:
 *   node src/watchdog.js [options]
 *
 * Options:
 *   --port <n>            Gateway port to monitor (default: 18789)
 *   --restart-delay <ms>  Initial restart delay (default: 2000)
 *   --max-delay <ms>      Max restart delay with backoff (default: 30000)
 *   --max-restarts <n>    Give up after N restarts, 0 = unlimited (default: 0)
 *   --health-interval <ms> Health check interval (default: 10000)
 *   --health-timeout <ms>  Health check timeout (default: 3000)
 *   --log-file <path>     Log file path (default: ~/.openclaw-watchdog/watchdog.log)
 *   --no-log-file         Disable file logging
 */

const { spawn, execSync } = require('child_process');
const { program }         = require('commander');
const fs                  = require('fs');
const path                = require('path');
const net                 = require('net');
const os                  = require('os');

// ── Platform ──────────────────────────────────────────────────────────────────

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

// ── Resolve openclaw executable ───────────────────────────────────────────────

function findExecutable() {
  if (PLATFORM === 'windows') {
    const npm = process.env.APPDATA
      ? path.join(process.env.APPDATA, 'npm')
      : null;
    const candidates = [
      // npm global install (most common on Windows)
      npm && path.join(npm, 'openclaw.cmd'),
      npm && path.join(npm, 'openclaw.ps1'),
      npm && path.join(npm, 'openclaw'),
      // Standalone installer locations
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'OpenClaw', 'openclaw.exe'),
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'OpenClaw', 'openclaw.exe'),
    ].filter(Boolean);
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return { cmd: c, args: [] }; } catch (_) {}
    }
    // Last resort: hope it's on PATH
    return { cmd: 'openclaw', args: [] };
  }

  if (PLATFORM === 'macos') {
    const candidates = [
      '/usr/local/bin/openclaw',
      '/opt/homebrew/bin/openclaw',
      '/Applications/OpenClaw.app/Contents/MacOS/openclaw',
      path.join(os.homedir(), 'Applications', 'OpenClaw.app', 'Contents', 'MacOS', 'openclaw'),
    ];
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return { cmd: c, args: [] }; } catch (_) {}
    }
    return { cmd: 'openclaw', args: [] };
  }

  // linux / wsl — use PATH
  return { cmd: 'openclaw', args: [] };
}

// ── Resolve health-check host ─────────────────────────────────────────────────
//
// On Windows/macOS/Linux the gateway runs locally → 127.0.0.1
// On WSL the gateway runs on the Windows host.
//   WSL2: host is reachable via the default-route gateway IP
//   WSL1: 127.0.0.1 reaches Windows directly
//
// We also set up a portproxy automatically on WSL2 so the Windows-side
// 127.0.0.1:18789 is forwarded to the WSL-visible host IP.

function getWSL2HostIP() {
  try {
    const out = execSync('ip route show default 2>/dev/null').toString();
    const m   = out.match(/default via ([\d.]+)/);
    if (m) return m[1];
  } catch (_) {}
  try {
    const out = fs.readFileSync('/etc/resolv.conf', 'utf8');
    const m   = out.match(/nameserver\s+([\d.]+)/);
    if (m) return m[1];
  } catch (_) {}
  return null;
}

function isWSL2() {
  try {
    const out = execSync('wslinfo --wsl-version 2>/dev/null').toString().trim();
    return out.includes('2');
  } catch (_) {}
  // Heuristic: WSL2 has a /run/WSL directory
  return fs.existsSync('/run/WSL');
}

function ensurePortProxy(hostIP, port) {
  // Add a Windows portproxy so that hostIP:port → 127.0.0.1:port
  // This lets WSL reach a gateway that only listens on 127.0.0.1
  try {
    execSync(
      `cmd.exe /c "netsh interface portproxy add v4tov4 listenport=${port} listenaddress=${hostIP} connectport=${port} connectaddress=127.0.0.1" 2>/dev/null`,
      { stdio: 'pipe' }
    );
  } catch (_) {
    // Non-fatal — user may not have admin rights; health check may still work
  }
}

function resolveHealthHost(port) {
  if (PLATFORM !== 'wsl') return '127.0.0.1';

  if (!isWSL2()) return '127.0.0.1';   // WSL1: loopback works

  const hostIP = getWSL2HostIP();
  if (!hostIP) return '127.0.0.1';

  ensurePortProxy(hostIP, port);
  return hostIP;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

program
  .name('openclaw-watchdog')
  .description('Keeps OpenClaw gateway alive on Windows, macOS, Linux, and WSL')
  .option('-p, --port <port>',             'Gateway port',                   '18789')
  .option('--restart-delay <ms>',          'Initial restart delay in ms',    '2000')
  .option('--max-delay <ms>',              'Max restart delay (backoff cap)', '30000')
  .option('--max-restarts <n>',            'Max restarts (0 = unlimited)',    '0')
  .option('--health-interval <ms>',        'Health check interval in ms',    '10000')
  .option('--health-timeout <ms>',         'Health check TCP timeout in ms', '3000')
  .option('--log-file <path>',             'Log file path',
    path.join(os.homedir(), '.openclaw-watchdog', 'watchdog.log'))
  .option('--no-log-file',                 'Disable file logging')
  .parse(process.argv);

const opts = program.opts();
const PORT = parseInt(opts.port, 10);

const { cmd: OPENCLAW_CMD, args: OPENCLAW_EXTRA_ARGS } = findExecutable();
const OPENCLAW_ARGS = [...OPENCLAW_EXTRA_ARGS, 'gateway'];
const HEALTH_HOST   = resolveHealthHost(PORT);

// ── Logger ────────────────────────────────────────────────────────────────────

if (opts.logFile) {
  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
}
const logStream = opts.logFile
  ? fs.createWriteStream(opts.logFile, { flags: 'a' })
  : null;

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  if (logStream) logStream.write(line + '\n');
}
const info  = m => log('INFO ', m);
const warn  = m => log('WARN ', m);
const error = m => log('ERROR', m);

// ── State ─────────────────────────────────────────────────────────────────────

let child        = null;
let restartCount = 0;
let currentDelay = parseInt(opts.restartDelay, 10);
let shuttingDown = false;
let healthTimer  = null;
let restartTimer = null;

// ── Health check ──────────────────────────────────────────────────────────────

function checkHealth() {
  return new Promise(resolve => {
    const sock    = new net.Socket();
    const timeout = parseInt(opts.healthTimeout, 10);
    sock.setTimeout(timeout);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error',   () => { sock.destroy(); resolve(false); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(PORT, HEALTH_HOST);
  });
}

function startHealthChecks() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    if (shuttingDown || !child) return;
    const alive = await checkHealth();
    if (!alive) {
      warn(`Health check failed on ${HEALTH_HOST}:${PORT}`);
      if (child && !child.killed) {
        warn('Killing unresponsive process to trigger restart');
        child.kill('SIGKILL');
      }
    }
  }, parseInt(opts.healthInterval, 10));
}

// ── Spawn ─────────────────────────────────────────────────────────────────────

function spawnGateway() {
  if (shuttingDown) return;

  info(`Spawning: ${OPENCLAW_CMD} ${OPENCLAW_ARGS.join(' ')}`);

  child = spawn(OPENCLAW_CMD, OPENCLAW_ARGS, {
    stdio: 'inherit',
    env:   process.env,
    ...(PLATFORM === 'windows' ? { windowsHide: true } : {}),
  });

  child.on('error', err => {
    error(`Spawn failed: ${err.message}`);
    scheduleRestart();
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      info('Gateway exited during shutdown — OK');
      return;
    }
    warn(`Gateway exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`);
    scheduleRestart();
  });

  child.on('spawn', () => {
    info(`Gateway started (pid=${child.pid})`);
    currentDelay = parseInt(opts.restartDelay, 10);
    startHealthChecks();
  });
}

function scheduleRestart() {
  if (shuttingDown) return;

  const max = parseInt(opts.maxRestarts, 10);
  if (max > 0 && restartCount >= max) {
    error(`Reached max restarts (${max}). Giving up.`);
    process.exit(1);
  }

  restartCount++;
  warn(`Restart #${restartCount} in ${currentDelay}ms...`);
  restartTimer = setTimeout(spawnGateway, currentDelay);
  currentDelay = Math.min(currentDelay * 2, parseInt(opts.maxDelay, 10));
}

// ── Shutdown ──────────────────────────────────────────────────────────────────

function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  info(`Received ${sig} — shutting down`);
  if (healthTimer)  clearInterval(healthTimer);
  if (restartTimer) clearTimeout(restartTimer);
  if (child && !child.killed) {
    info(`Stopping gateway (pid=${child.pid})`);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child && !child.killed) child.kill('SIGKILL');
      process.exit(0);
    }, 5000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  err    => error(`Uncaught: ${err.stack}`));
process.on('unhandledRejection', reason => error(`Unhandled rejection: ${reason}`));

// ── Start ─────────────────────────────────────────────────────────────────────

info('='.repeat(60));
info('openclaw-watchdog v2');
info(`Platform : ${PLATFORM}`);
info(`Command  : ${OPENCLAW_CMD} ${OPENCLAW_ARGS.join(' ')}`);
info(`Monitor  : ${HEALTH_HOST}:${PORT}`);
info(`Log      : ${opts.logFile || 'console only'}`);
info('='.repeat(60));

spawnGateway();
