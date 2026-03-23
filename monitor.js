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
function startGateway() {
  if (gatewayProcess) return;

  log("INFO", `Starting openclaw gateway: openclaw gateway ${CONFIG.gatewayArgs.join(" ")}`);

  // Resolve openclaw binary path
  const bin = process.platform === "win32" ? "openclaw.cmd" : "openclaw";

  gatewayProcess = spawn(bin, ["gateway", ...CONFIG.gatewayArgs], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    detached: false,
  });

  gatewayProcess.stdout.on("data", (d) => {
    const lines = d.toString().trim().split("\n");
    lines.forEach((l) => l && console.log(`  \x1b[90m[gateway] ${l}\x1b[0m`));
  });

  gatewayProcess.stderr.on("data", (d) => {
    const lines = d.toString().trim().split("\n");
    lines.forEach((l) => l && console.log(`  \x1b[33m[gateway] ${l}\x1b[0m`));
  });

  gatewayProcess.on("exit", (code, signal) => {
    if (isRunning) {
      log("WARN", `Gateway process exited (code=${code}, signal=${signal})`);
    }
    gatewayProcess = null;
  });

  gatewayProcess.on("error", (err) => {
    if (err.code === "ENOENT") {
      log("ERROR", `'openclaw' command not found. Is it installed? (npm install -g openclaw@latest)`);
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
