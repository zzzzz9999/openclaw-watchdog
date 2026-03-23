#!/usr/bin/env node
/**
 * OpenClaw Gateway Monitor
 * Monitors openclaw gateway status and auto-restarts it when it goes down.
 * Works on Windows (WSL), macOS, and Linux.
 */

const net = require("net");
const { spawn } = require("child_process");
const os = require("os");
const readline = require("readline");

// --- Config ---
const CONFIG = {
  host: "127.0.0.1",
  port: parseInt(process.env.OPENCLAW_PORT || "18789"),
  checkIntervalMs: parseInt(process.env.CHECK_INTERVAL || "5000"),  // 5s
  restartDelayMs: parseInt(process.env.RESTART_DELAY || "2000"),    // 2s after detect down
  maxRestarts: parseInt(process.env.MAX_RESTARTS || "0"),           // 0 = unlimited
  gatewayArgs: (process.env.GATEWAY_ARGS || "--port 18789 --verbose").split(" "),
};

// --- State ---
let gatewayProcess = null;
let restartCount = 0;
let isRunning = true;
let lastStatus = null; // "up" | "down"

// --- Utilities ---
function timestamp() {
  return new Date().toLocaleString();
}

function log(level, msg) {
  const colors = {
    INFO:  "\x1b[36m",
    OK:    "\x1b[32m",
    WARN:  "\x1b[33m",
    ERROR: "\x1b[31m",
    RESET: "\x1b[0m",
  };
  const c = colors[level] || "";
  console.log(`${c}[${timestamp()}] [${level}] ${msg}${colors.RESET}`);
}

function clearLine() {
  process.stdout.write("\r\x1b[K");
}

// --- Check if gateway port is open ---
function checkGateway() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket
      .connect(CONFIG.port, CONFIG.host, () => {
        socket.destroy();
        resolve(true);
      })
      .on("error", () => resolve(false))
      .on("timeout", () => { socket.destroy(); resolve(false); });
  });
}

// --- Start gateway process ---
// Fatal patterns: errors that retrying will never fix
const FATAL_PATTERNS = [
  { pattern: /Node\.js.+required/,      msg: "Gateway requires a newer Node.js version.\n  Fix: nvm install 22 && nvm use 22 && nvm alias default 22" },
  { pattern: /Missing config/,           msg: "Gateway is not configured.\n  Fix: run 'openclaw setup' first, then restart the monitor." },
  { pattern: /openclaw setup/,           msg: "Gateway is not configured.\n  Fix: run 'openclaw setup' first, then restart the monitor." },
];

let gatewayOutput = "";

function startGateway() {
  if (gatewayProcess) return;

  log("INFO", `Starting openclaw gateway: openclaw gateway ${CONFIG.gatewayArgs.join(" ")}`);

  const bin = process.platform === "win32" ? "openclaw.cmd" : "openclaw";
  gatewayOutput = "";

  gatewayProcess = spawn(bin, ["gateway", ...CONFIG.gatewayArgs], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    detached: false,
  });

  function onData(d) {
    const text = d.toString();
    gatewayOutput += text;
    text.trim().split("\n").forEach((l) => l && console.log(`  \x1b[90m[gateway] ${l}\x1b[0m`));
  }

  gatewayProcess.stdout.on("data", onData);
  gatewayProcess.stderr.on("data", onData);

  gatewayProcess.on("exit", (code, signal) => {
    if (!isRunning) return;
    // Check for fatal errors
    for (const { pattern, msg } of FATAL_PATTERNS) {
      if (pattern.test(gatewayOutput)) {
        log("ERROR", msg);
        isRunning = false;
        process.exit(1);
      }
    }
    log("WARN", `Gateway process exited (code=${code}, signal=${signal})`);
    gatewayProcess = null;
  });

  gatewayProcess.on("error", (err) => {
    if (err.code === "ENOENT") {
      log("ERROR", "'openclaw' command not found.\n  Fix: npm install -g openclaw@latest");
      isRunning = false;
      process.exit(1);
    } else {
      log("ERROR", `Failed to start gateway: ${err.message}`);
    }
    gatewayProcess = null;
  });
}

// --- Stop gateway process ---
function stopGateway() {
  if (!gatewayProcess) return;
  log("INFO", "Stopping gateway process...");
  gatewayProcess.kill("SIGTERM");
  gatewayProcess = null;
}

// --- Print status bar ---
let spinnerIdx = 0;
const SPINNER = ["|", "/", "-", "\\"];

function printStatus(up) {
  if (!process.stdout.isTTY) return;
  const spin = SPINNER[spinnerIdx++ % SPINNER.length];
  const statusStr = up
    ? "\x1b[32m[RUNNING]\x1b[0m"
    : "\x1b[31m[DOWN]\x1b[0m";
  clearLine();
  process.stdout.write(
    `${spin} openclaw gateway ${statusStr}  port=${CONFIG.port}  restarts=${restartCount}  (Ctrl+C to quit)`
  );
}

// --- Main monitor loop ---
async function monitorLoop() {
  log("INFO", `OpenClaw Gateway Monitor started`);
  log("INFO", `Monitoring ${CONFIG.host}:${CONFIG.port} every ${CONFIG.checkIntervalMs / 1000}s`);
  log("INFO", `Press Ctrl+C to stop`);
  console.log("");

  while (isRunning) {
    const up = await checkGateway();

    if (up && lastStatus !== "up") {
      if (process.stdout.isTTY) clearLine();
      log("OK", `Gateway is UP on port ${CONFIG.port}`);
      lastStatus = "up";
    }

    if (!up && lastStatus !== "down") {
      if (process.stdout.isTTY) clearLine();
      log("WARN", `Gateway is DOWN - will restart in ${CONFIG.restartDelayMs / 1000}s...`);
      lastStatus = "down";
    }

    printStatus(up);

    if (!up && isRunning) {
      // Wait restart delay then attempt to start
      await new Promise((r) => setTimeout(r, CONFIG.restartDelayMs));
      if (!isRunning) break;

      if (CONFIG.maxRestarts > 0 && restartCount >= CONFIG.maxRestarts) {
        if (process.stdout.isTTY) clearLine();
        log("ERROR", `Max restarts (${CONFIG.maxRestarts}) reached. Giving up.`);
        break;
      }

      restartCount++;
      if (process.stdout.isTTY) clearLine();
      log("INFO", `Restarting gateway... (attempt #${restartCount})`);
      stopGateway();
      startGateway();

      // Wait a bit for gateway to come up before next check
      await new Promise((r) => setTimeout(r, 3000));
    } else {
      await new Promise((r) => setTimeout(r, CONFIG.checkIntervalMs));
    }
  }
}

// --- Graceful shutdown ---
function shutdown() {
  isRunning = false;
  if (process.stdout.isTTY) clearLine();
  log("INFO", "Shutting down monitor...");
  stopGateway();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Windows Ctrl+C via readline
if (process.platform === "win32") {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", shutdown);
}

// --- Entry point ---
monitorLoop().catch((err) => {
  log("ERROR", err.message);
  process.exit(1);
});
