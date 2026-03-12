const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const os = require('os');

const CONFIG = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const STYLES = { reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m', green: '\x1b[32m', dim: '\x1b[2m', yellow: '\x1b[33m', bgCyan: '\x1b[46m', bgGreen: '\x1b[42m', white: '\x1b[37m', red: '\x1b[31m' };

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
const EXTERNAL_HOST = `${getLocalIP()}:${CONFIG.CLI_PORT || 3002}`;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `\n${STYLES.bgGreen}${STYLES.white}${STYLES.bold} USER ${STYLES.reset} ` });
let history = [], executorSkills = [], capabilitiesSummary = "", totalPromptTokens = 0, totalResponseTokens = 0, currentAbortController = null;

function safePrompt() { if (rl && !rl.closed) try { rl.prompt(); } catch (e) {} }

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(express.static(path.join(__dirname, 'web')));

// API 路由
app.post('/api/log', (req, res) => { broadcast({ type: req.body.type, content: req.body.content }); res.sendStatus(200); });

// 下载代理路由 - 转发到 MCP Server
app.get('/download', async (req, res) => {
  try {
    const targetUrl = `http://localhost:3000/download?${new URLSearchParams(req.query).toString()}`;
    const response = await fetch(targetUrl);
    if (!response.ok) return res.status(response.status).send(await response.text());
    
    // 转发头信息
    const contentType = response.headers.get('content-type');
    const contentDisposition = response.headers.get('content-disposition');
    if (contentType) res.setHeader('Content-Type', contentType);
    if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);
    
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (e) {
    res.status(500).send(`Download Proxy Error: ${e.message}`);
  }
});

app.get('/api/skills', async (req, res) => {
  try { const r = await fetch(`http://localhost:${CONFIG.EXECUTOR_PORT}/skills`); res.json(await r.json()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/set_skill', async (req, res) => {
  try {
    await fetch(`http://localhost:${CONFIG.EXECUTOR_PORT}/set_skill_status`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(req.body) });
    const rCap = await fetch(`http://localhost:${CONFIG.EXECUTOR_PORT}/capabilities`);
    capabilitiesSummary = (await rCap.json()).summary;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

function broadcast(data) { wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data)); }); }
function broadcastConfig() {
  broadcast({ 
    type: 'config', cli_think: CONFIG.CLI_THINK, exec_think: CONFIG.EXECUTOR_THINK,
    cli_model: `${CONFIG.CLI_LLM.MODEL}`, exec_model: `${CONFIG.EXECUTOR_LLM.MODEL}`,
    tokens: { total: totalPromptTokens + totalResponseTokens, prompt: totalPromptTokens, response: totalResponseTokens }
  });
}

function getSystemPrompt() {
  let p = fs.existsSync('system.md') ? fs.readFileSync('system.md', 'utf8') : "";
  if (capabilitiesSummary) p += `\n\n### System Capabilities:\n${capabilitiesSummary}`;
  return p;
}

async function setup() {
  try {
    const executorUrl = `http://localhost:${CONFIG.EXECUTOR_PORT}`;
    const resList = await fetch(`${executorUrl}/list`);
    const dataList = await resList.json();
    executorSkills = dataList.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    const resCap = await fetch(`${executorUrl}/capabilities`);
    capabilitiesSummary = (await resCap.json()).summary;
    console.log(`${STYLES.green}Crisis Agent Connected (${executorSkills.length} tools).${STYLES.reset}`);
  } catch (e) { console.error(`${STYLES.red}Connection failed: ${e.message}${STYLES.reset}`); }
}

async function chat(input, images = [], files = []) {
  const userMsg = { role: 'user', content: input };
  if (images && images.length > 0) userMsg.images = images;
  if (files && files.length > 0) userMsg.files = files;
  if (input || images?.length || files?.length) history.push(userMsg);

  while (true) {
    currentAbortController = new AbortController();
    const systemPrompt = getSystemPrompt();
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
            if (data.message?.thinking) {
              if (!isThinking) { process.stdout.write(`\n${STYLES.dim}[思考中]\n `); isThinking = true; }
              process.stdout.write(data.message.thinking); broadcast({ type: 'thinking_chunk', content: data.message.thinking });
            }
            if (data.message?.content) {
              if (isThinking) { process.stdout.write(`${STYLES.reset}\n\n[结果]\n`); isThinking = false; }
              process.stdout.write(data.message.content); broadcast({ type: 'stream_chunk', content: data.message.content });
              fullContent += data.message.content;
            }
            if (data.message?.tool_calls) toolCalls = toolCalls.concat(data.message.tool_calls);
            if (data.done) { totalPromptTokens += (data.prompt_eval_count || 0); totalResponseTokens += (data.eval_count || 0); broadcastConfig(); }
          } catch (e) {}
        }
      }

      const assistantMsg = { role: 'assistant', content: fullContent };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      history.push(assistantMsg);

      if (toolCalls.length > 0) {
        for (const call of toolCalls) {
          let rawTask = call.function.arguments.task;
          const taskObj = { 
            result: true, 
            message: (typeof rawTask === 'object') ? (rawTask.message || rawTask.instruction) : rawTask,
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
          const resText = skillData.result ? skillData.message : `[ERROR] ${skillData.message}`;
          console.log(`\n${STYLES.dim}[Tool Result]: ${resText.substring(0, 200)}...${STYLES.reset}`);
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
  else if (input === '/reboot') { setTimeout(() => process.exit(99), 500); }
  else await chat(input, images, files);
}

setup().then(() => {
  const port = CONFIG.CLI_PORT || 3002;
  server.listen(port, "0.0.0.0", () => console.log(`Web UI: http://localhost:${port}`));
  rl.on('line', l => processInput(l, 'terminal'));
  safePrompt();
});
