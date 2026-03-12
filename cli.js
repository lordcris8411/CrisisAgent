const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const os = require('os');

const CONFIG = JSON.parse(fs.readFileSync('config.json', 'utf8'));

const STYLES = { 
  reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m', green: '\x1b[32m', dim: '\x1b[2m', 
  yellow: '\x1b[33m', bgCyan: '\x1b[46m', bgGreen: '\x1b[42m', white: '\x1b[37m', red: '\x1b[31m'
};

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if ((iface.family === 'IPv4' || iface.family === 4) && !iface.internal) {
        if (iface.address.startsWith('169.254.')) continue;
        const isVirtual = /vEthernet|VirtualBox|VMware|WSL|ZeroTier|Tailscale|TAP|VPN|Pseudo|Clash|FlClash/i.test(name);
        const isPhysical = /Ethernet|Wi-Fi|WLAN|浠ュお缃|以太网|无线网络连接/i.test(name);
        candidates.push({ address: iface.address, name, isVirtual, isPhysical });
      }
    }
  }
  if (candidates.length === 0) return '127.0.0.1';
  candidates.sort((a, b) => ((b.isPhysical ? 2 : 0) + (b.isVirtual ? 0 : 1)) - ((a.isPhysical ? 2 : 0) + (a.isVirtual ? 0 : 1)));
  return candidates[0].address;
}
const EXTERNAL_HOST = `${getLocalIP()}:3000`;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `\n${STYLES.bgGreen}${STYLES.white}${STYLES.bold} USER ${STYLES.reset} ` });

let history = [], executorSkills = [], capabilitiesSummary = "", totalPromptTokens = 0, totalResponseTokens = 0, currentAbortController = null;

function safePrompt() { if (rl && !rl.closed) try { rl.prompt(); } catch (e) {} }

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.post('/api/log', (req, res) => { broadcast({ type: req.body.type, content: req.body.content }); res.sendStatus(200); });

wss.on('connection', (ws) => {
  ws.on('message', async (msg) => {
    const data = JSON.parse(msg);
    if (data.type === 'chat') {
      console.log(`\n${STYLES.bgGreen}${STYLES.white}${STYLES.bold} USER (Web) ${STYLES.reset} ${data.content}`);
      await processInput(data.content, 'web', data.images, data.files);
      if (data.content !== '/reboot' && data.content !== '/exit') safePrompt();
    } else if (data.type === 'stop' && currentAbortController) {
      currentAbortController.abort(); currentAbortController = null;
      fetch(`http://localhost:${CONFIG.EXECUTOR_PORT}/interrupt`, { method: 'POST' }).catch(() => {});
      broadcast({ type: 'stream_end' });
    }
  });
  ws.send(JSON.stringify({ type: 'history', history }));
  broadcastConfig();
});

function broadcast(data) { wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data)); }); }

function broadcastConfig() {
  broadcast({ 
    type: 'config', cli_think: CONFIG.CLI_THINK, exec_think: CONFIG.EXECUTOR_THINK,
    cli_model: `${CONFIG.CLI_LLM.MODEL}`, exec_model: `${CONFIG.EXECUTOR_LLM.MODEL}`,
    tokens: { total: totalPromptTokens + totalResponseTokens, prompt: totalPromptTokens, response: totalResponseTokens }
  });
}

function getSystemPrompt() {
  let prompt = fs.existsSync('system.md') ? fs.readFileSync('system.md', 'utf8') : "";
  if (capabilitiesSummary) prompt += `\n\n### Capabilities:\n${capabilitiesSummary}`;
  return prompt;
}

async function setup() {
  try {
    const resList = await fetch(`http://localhost:${CONFIG.EXECUTOR_PORT}/list`);
    const dataList = await resList.json();
    executorSkills = dataList.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    const resCap = await fetch(`http://localhost:${CONFIG.EXECUTOR_PORT}/capabilities`);
    const dataCap = await resCap.json();
    capabilitiesSummary = dataCap.summary;
    console.log(`${STYLES.green}Crisis Agent Connected. Type /help.${STYLES.reset}`);
  } catch (e) { console.error("Connection failed:", e.message); }
}

async function chat(input, images = [], files = []) {
  const userMsg = { role: 'user', content: input };
  if (images && images.length > 0) userMsg.images = images;
  if (files && files.length > 0) userMsg.files = files;
  if (input || images?.length || files?.length) history.push(userMsg);

  while (true) {
    currentAbortController = new AbortController();
    const systemPrompt = getSystemPrompt() + "\n\nCRITICAL: Always use 'delegate_task' for system actions.";
    const formattedHistory = history.map(m => {
      let content = m.content;
      if (m.role === 'user' && m.files?.length) content = `[Files: ${m.files.map(f=>f.name).join(', ')}]\n${content}`;
      const newMsg = { ...m, content };
      if (m.images) newMsg.images = m.images.map(img => typeof img === 'string' ? img : img.data);
      return newMsg;
    });

    try {
      const response = await fetch(`${CONFIG.CLI_LLM.HOST}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: CONFIG.CLI_LLM.MODEL, messages: [{ role: 'system', content: systemPrompt }, ...formattedHistory], tools: executorSkills, think: CONFIG.CLI_THINK, stream: true }),
        signal: currentAbortController.signal
      });

      const reader = response.body.getReader(), decoder = new TextDecoder();
      let fullContent = "", toolCalls = [], buffer = '', isThinking = false;
      broadcast({ type: 'stream_start' });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n'); buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            const msg = data.message;
            if (msg?.thinking) {
              if (!isThinking) { process.stdout.write(`\n${STYLES.dim}[思考中]\n `); isThinking = true; }
              process.stdout.write(msg.thinking); broadcast({ type: 'thinking_chunk', content: msg.thinking });
            }
            if (msg?.content) {
              if (isThinking) { process.stdout.write(`${STYLES.reset}\n\n[结果]\n`); isThinking = false; }
              process.stdout.write(msg.content); broadcast({ type: 'stream_chunk', content: msg.content });
              fullContent += msg.content;
            }
            if (msg?.tool_calls) toolCalls = toolCalls.concat(msg.tool_calls);
            if (data.done) { totalPromptTokens += (data.prompt_eval_count || 0); totalResponseTokens += (data.eval_count || 0); broadcastConfig(); }
          } catch (e) {}
        }
      }

      const assistantMsg = { role: 'assistant', content: fullContent };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      history.push(assistantMsg);

      if (toolCalls.length > 0) {
        for (const call of toolCalls) {
          // 构造符合新协议的请求: { result, message, attachment, data }
          const taskObj = {
            result: true,
            message: call.function.arguments.task.instruction || call.function.arguments.task,
            attachment: files,
            data: { images: images.map(img => typeof img === 'string' ? img : img.data) }
          };

          const res = await fetch(`http://localhost:${CONFIG.EXECUTOR_PORT}/call`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ arguments: { task: taskObj }, clientHost: EXTERNAL_HOST }),
            signal: currentAbortController.signal
          });

          const skillData = await res.json();
          if (skillData.data?.tokens) { totalPromptTokens += skillData.data.tokens.prompt; totalResponseTokens += skillData.data.tokens.completion; broadcastConfig(); }
          if (skillData.data?.images) skillData.data.images.forEach(img => broadcast({ type: 'stream_image', data: img }));
          
          const resultText = skillData.result ? skillData.message : `[ERROR] ${skillData.message}`;
          console.log(`\n${STYLES.dim}[Tool Result]: ${resultText.substring(0, 200)}...${STYLES.reset}`);
          history.push({ role: 'tool', content: resultText, tool_call_id: call.id });
        }
        continue;
      }
      break;
    } catch (e) { break; } finally { currentAbortController = null; }
  }
  broadcast({ type: 'stream_end' });
}

async function processInput(line, source = 'terminal', images = [], files = []) {
  const input = line.trim();
  if (!input && !images?.length && !files?.length) return;
  if (source === 'terminal') broadcast({ role: 'user', content: input });

  if (input === '/exit') process.exit(0);
  else if (input === '/clear') { console.clear(); broadcast({ type: 'clear' }); }
  else if (input === '/reset') { history = []; totalPromptTokens = 0; totalResponseTokens = 0; broadcast({ type: 'history', history: [] }); broadcastConfig(); }
  else if (input === '/help') {
    const help = `\n/clear, /reset, /reboot, /exit, /context, /system, /exe_system, /list skills, /list mcp functions, /set skill <name> <on/off>\n`;
    console.log(help); if (source === 'web') broadcast({ type: 'console_log', content: help });
  }
  else if (input === '/reboot') { setTimeout(() => process.exit(99), 500); }
  else await chat(input, images, files);
}

setup().then(() => {
  server.listen(3002, () => console.log(`Web at http://localhost:3002` || `Web at http://${getLocalIP()}:3002`));
  rl.on('line', l => processInput(line, 'terminal'));
  safePrompt();
});