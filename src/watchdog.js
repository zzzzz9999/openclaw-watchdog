#!/usr/bin/env node
'use strict';

/**
 * openclaw-watchdog
 *
 * Monitors the OpenClaw gateway process and automatically restarts it
 * if it crashes or exits unexpectedly during task execution.
 *
 * How it works:
 *   1. Spawns `openclaw gateway` as a child process
 *   2. Monitors the process health via WebSocket ping to ws://127.0.0.1:18789
 *   3. On crash/exit: waits a backoff delay, then restarts
 *   4. On intentional shutdown (SIGTERM/SIGINT to watchdog): cleanly stops everything
 *   5. Writes logs to ~/.openclaw-watchdog/watchdog.log
 */

const { spawn } = require('child_process');
const { program } = require('commander');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');

// ── Config ────────────────────────────────────────────────────────────────────

program
  .name('openclaw-watchdog')
  .description('Keeps OpenClaw alive during task execution')
  .option('-c, --command <cmd>', 'Command to launch OpenClaw', 'openclaw')
  .option('-a, --args <args>', 'Arguments for OpenClaw', 'gateway')
  .option('-p, --port <port>', 'OpenClaw gateway port to health-check', '18789')
  .option('--max-restarts <n>', 'Max restarts before giving up (0 = unlimited)', '0')
  .option('--restart-delay <ms>', 'Initial restart delay in ms', '2000')
  .option('--max-delay <ms>', 'Maximum restart delay (exponential backoff cap)', '30000')
  .option('--health-interval <ms>', 'Health check interval in ms', '10000')
  .option('--health-timeout <ms>', 'Health check TCP timeout in ms', '3000')
  .option('--log-file <path>', 'Log file path', path.join(os.homedir(), '.openclaw-watchdog', 'watchdog.log'))
  .option('--no-log-file', 'Disable file logging')
  .parse(process.argv);

const opts = program.opts();

// ── Logger ────────────────────────────────────────────────────────────────────

const logDir = path.dirname(opts.logFile);
if (opts.logFile && !fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

let logStream = null;
if (opts.logFile) {
  logStream = fs.createWriteStream(opts.logFile, { flags: 'a' });
}

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  if (logStream) logStream.write(line + '\n');
}

const info  = (m) => log('INFO ', m);
const warn  = (m) => log('WARN ', m);
const error = (m) => log('ERROR', m);

// ── State ─────────────────────────────────────────────────────────────────────

let child = null;
let restartCount = 0;
let currentDelay = parseInt(opts.restartDelay, 10);
let shuttingDown = false;   // set when watchdog itself is asked to stop
let healthTimer = null;
let restartTimer = null;

// ── Health check ──────────────────────────────────────────────────────────────

/**
 * Returns true if OpenClaw's gateway port is accepting TCP connections.
 * This is faster and more reliable than a full WebSocket handshake.
 */
function checkHealth() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeout = parseInt(opts.healthTimeout, 10);

    socket.setTimeout(timeout);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error',   () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });

    socket.connect(parseInt(opts.port, 10), '127.0.0.1');
  });
}

function startHealthChecks() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    if (shuttingDown || !child) return;

    const alive = await checkHealth();
    if (!alive) {
      warn(`Health check failed on port ${opts.port} — process may be frozen`);
      // If the port is gone but the process is still "running", kill it so
      // the exit handler triggers a restart.
      if (child && !child.killed) {
        warn('Killing unresponsive OpenClaw process to trigger restart');
        child.kill('SIGKILL');
      }
    }
  }, parseInt(opts.healthInterval, 10));
}

// ── Process management ────────────────────────────────────────────────────────

function spawnOpenClaw() {
  if (shuttingDown) return;

  const cmd  = opts.command;
  const args = opts.args.split(/\s+/).filter(Boolean);

  info(`Starting OpenClaw: ${cmd} ${args.join(' ')}`);

  child = spawn(cmd, args, {
    stdio: 'inherit',   // share stdout/stderr with watchdog so logs stay visible
    env: process.env,
    detached: false,
  });

  child.on('error', (err) => {
    error(`Failed to spawn OpenClaw: ${err.message}`);
    scheduleRestart();
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      info('OpenClaw exited cleanly during watchdog shutdown');
      return;
    }

    if (signal === 'SIGTERM' || signal === 'SIGINT') {
      // Intentional stop — don't restart
      info(`OpenClaw stopped by signal ${signal} — not restarting`);
      return;
    }

    warn(`OpenClaw exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`);
    scheduleRestart();
  });

  child.on('spawn', () => {
    info(`OpenClaw started (pid=${child.pid})`);
    // Reset backoff on successful start
    currentDelay = parseInt(opts.restartDelay, 10);
    startHealthChecks();
  });
}

function scheduleRestart() {
  if (shuttingDown) return;

  const maxRestarts = parseInt(opts.maxRestarts, 10);
  if (maxRestarts > 0 && restartCount >= maxRestarts) {
    error(`Reached max restarts (${maxRestarts}). Giving up.`);
    process.exit(1);
  }

  restartCount++;
  warn(`Scheduling restart #${restartCount} in ${currentDelay}ms...`);

  restartTimer = setTimeout(() => {
    spawnOpenClaw();
  }, currentDelay);

  // Exponential backoff, capped at maxDelay
  const maxDelay = parseInt(opts.maxDelay, 10);
  currentDelay = Math.min(currentDelay * 2, maxDelay);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  info(`Watchdog received ${signal} — shutting down gracefully`);

  if (healthTimer)  clearInterval(healthTimer);
  if (restartTimer) clearTimeout(restartTimer);

  if (child && !child.killed) {
    info(`Sending SIGTERM to OpenClaw (pid=${child.pid})`);
    child.kill('SIGTERM');

    // Give it 5 seconds to exit cleanly, then force-kill
    setTimeout(() => {
      if (child && !child.killed) {
        warn('OpenClaw did not exit in time — sending SIGKILL');
        child.kill('SIGKILL');
      }
      process.exit(0);
    }, 5000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Prevent uncaught errors in the watchdog itself from taking everything down
process.on('uncaughtException', (err) => {
  error(`Uncaught exception in watchdog: ${err.stack}`);
});
process.on('unhandledRejection', (reason) => {
  error(`Unhandled rejection in watchdog: ${reason}`);
});

// ── Entry ─────────────────────────────────────────────────────────────────────

info('='.repeat(60));
info('openclaw-watchdog starting');
info(`Command : ${opts.command} ${opts.args}`);
info(`Port    : ${opts.port}`);
info(`Log     : ${opts.logFile || 'console only'}`);
info('='.repeat(60));

spawnOpenClaw();
