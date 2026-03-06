const { spawn } = require('child_process');
const path = require('path');

const STYLES = { reset: '\x1b[0m', yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m' };

let isRebooting = false;

function relayLogToWeb(content) {
  const cleanText = content.replace(/\x1b\[[0-9;]*m/g, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 100);
  
  fetch(`http://localhost:3002/api/log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: cleanText, type: 'console_log' }),
    signal: controller.signal
  }).catch(() => {}).finally(() => clearTimeout(timeout));
}

function startProcess(name, script, color)
{
  const child = spawn('node', [script], { stdio: 'inherit' });
  child.isKilledBySystem = false;
  const msg = `[System] Starting ${name} (${script})...`;
  console.log(`${color}${msg}${STYLES.reset}`);
  relayLogToWeb(msg);
  
  child.on('error', (err) => 
  {
    const errorMsg = `[System] Failed to start ${name}: ${err.message}`;
    console.error(`${STYLES.red}${errorMsg}${STYLES.reset}`);
    relayLogToWeb(errorMsg);
  });

  child.on('exit', async (code) => 
  {
    // 如果进程是被系统主动杀死的，或者是正在重启中且不是 99 信号，则完全静默
    if (child.isKilledBySystem || (isRebooting && code !== 99)) return;

    if (code === 99)
    {
      if (isRebooting) return; // 防止重复触发
      isRebooting = true;
      
      const rebootMsg = `\n[System] Global Reboot Initiated...`;
      console.log(`${STYLES.cyan}${rebootMsg}${STYLES.reset}`);
      relayLogToWeb(rebootMsg);
      
      // 1. 强制杀死另一个进程 (如果有的话)
      // 在这种父子架构下，由 start.js 统一管理
      
      // 2. 重新按照顺序启动
      await main();
      
      isRebooting = false;
    }
    else if (code !== 0 && code !== null)
    {
      const crashMsg = `[System] ${name} crashed with code ${code}`;
      console.log(`${STYLES.red}${crashMsg}${STYLES.reset}`);
      relayLogToWeb(crashMsg);
      process.exit(code);
    }
    else
    {
      const stoppedMsg = `[System] ${name} stopped (code ${code})`;
      console.log(`${color}${stoppedMsg}${STYLES.reset}`);
      relayLogToWeb(stoppedMsg);
    }
  });

  return child;
}

let executorProcess = null;
let cliProcess = null;

async function main()
{
  // 1. 清理旧进程
  if (executorProcess) {
    executorProcess.isKilledBySystem = true;
    try { executorProcess.kill(); } catch(e) {}
  }
  if (cliProcess) {
    cliProcess.isKilledBySystem = true;
    try { cliProcess.kill(); } catch(e) {}
  }

  // 1. 启动 Executor
  executorProcess = startProcess('Executor', 'executor_server.js', STYLES.yellow);

  // 2. 给予充足的启动时间
  const waitMsg = `[System] Waiting 3s for Executor to be ready...`;
  console.log(`${STYLES.cyan}${waitMsg}${STYLES.reset}`);
  relayLogToWeb(waitMsg);
  await new Promise(resolve => setTimeout(resolve, 3000));

  // 3. 启动 CLI
  const launchMsg = `[System] Launching CLI Interface...`;
  console.log(`${STYLES.cyan}${launchMsg}${STYLES.reset}`);
  relayLogToWeb(launchMsg);
  cliProcess = startProcess('CLI', 'cli.js', STYLES.cyan);
}

main();
