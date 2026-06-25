/**
 * @file start.js
 * @description Zero-dependency process manager to run both Web Server and Watcher Daemon concurrently.
 */

const { spawn } = require('child_process');
const path = require('path');

console.log("=========================================================================");
console.log("🌟 Starting eBay Multi-Channel Lister System Processes...");
console.log("=========================================================================\n");

const processes = [
  {
    name: 'Web Server',
    script: 'webServer.js',
    args: [],
    color: '\x1b[36m', // Cyan
    instance: null,
    restartCount: 0
  },
  {
    name: 'Watcher Daemon',
    script: 'simple-lister-pro.js',
    args: ['--watch'],
    color: '\x1b[33m', // Yellow
    instance: null,
    restartCount: 0
  }
];

const MAX_RESTARTS = 5;
const RESET_TIMEOUT = 30000; // Reset restart count if process runs stable for 30s
const colorReset = '\x1b[0m';

function startProcess(proc) {
  const scriptPath = path.join(__dirname, proc.script);
  console.log(`${proc.color}[System] Starting ${proc.name}...${colorReset}`);
  
  const child = spawn('node', [scriptPath, ...(proc.args || [])], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  proc.instance = child;

  // Track stability time
  const timer = setTimeout(() => {
    proc.restartCount = 0;
  }, RESET_TIMEOUT);

  // Helper to handle log output formatting
  const handleOutput = (data, isError = false) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim().length > 0) {
        const timestamp = new Date().toLocaleTimeString();
        const prefix = `${proc.color}[${proc.name}] [${timestamp}]${colorReset}`;
        if (isError) {
          console.error(`${prefix} \x1b[31m${line}${colorReset}`);
        } else {
          console.log(`${prefix} ${line}`);
        }
      }
    }
  };

  child.stdout.on('data', data => handleOutput(data));
  child.stderr.on('data', data => handleOutput(data, true));

  child.on('close', code => {
    clearTimeout(timer);
    console.log(`${proc.color}[System] ${proc.name} exited with code ${code}${colorReset}`);
    
    // If it was terminated intentionally, don't restart
    if (global.shuttingDown) return;

    if (proc.restartCount < MAX_RESTARTS) {
      proc.restartCount++;
      const delay = Math.pow(2, proc.restartCount) * 1000;
      console.log(`${proc.color}[System] Restarting ${proc.name} in ${delay / 1000}s (Retry ${proc.restartCount}/${MAX_RESTARTS})...${colorReset}`);
      setTimeout(() => startProcess(proc), delay);
    } else {
      console.error(`❌ Error: ${proc.name} has crashed repeatedly. Shutting down system.`);
      shutdownAll();
    }
  });
}

function shutdownAll() {
  if (global.shuttingDown) return;
  global.shuttingDown = true;
  console.log("\n🛑 Shutting down all processes cleanly...");
  for (const proc of processes) {
    if (proc.instance) {
      console.log(`[System] Terminating ${proc.name} (PID: ${proc.instance.pid})...`);
      proc.instance.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(0), 1000);
}

// Intercept exit signals
process.on('SIGINT', shutdownAll);
process.on('SIGTERM', shutdownAll);

// Start both processes
for (const proc of processes) {
  startProcess(proc);
}
