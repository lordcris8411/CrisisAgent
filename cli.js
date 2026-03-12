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

async function fetchWithTimeout(url, options = {}, timeout = 60000) {
  const controller = new AbortController();
  const id = setTimeout(() => {
    console.error(`[CLI TIMEOUT] ${url} exceeded ${timeout}ms`);
    controller.abort();
  }, timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id); return response;
  } catch (e) { clearTimeout(id); throw e; }
}

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

app.post('/api/log', (req, res) => { broadcast({ type: req.body.type, content: req.body.content }); res.sendStatus(200); });

app.get('/download', async (req, res) => {
  try {
    const targetUrl = `http://localhost:3000/download?${new URLSearchParams(req.query).toString()}`;
    const response = await fetchWithTimeout(targetUrl, {}, 30000);
    if (!response.ok) return res.status(response.status).send(await response.text());
    const contentType = response.headers.get('content-type');
    const contentDisposition = response.headers.get('content-disposition');
    if (contentType) res.setHeader('Content-Type', contentType);
    if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (e) { res.status(500).send(`Download Error: ${e.message}`); }
});

app.get('/api/skills', async (req, res) => {
  try { const r = await fetchWithTimeout(`http://localhost:${CONFIG.EXECUTOR_PORT}/skills`, {}, 5000); res.json(await r.json()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/set_skill', async (req, res) => {
  try {
    await fetchWithTimeout(`http://localhost:${CONFIG.EXECUTOR_PORT}/set_skill_status`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(req.body) }, 5000);
    const rCap = await fetchWithTimeout(`http://localhost:${CONFIG.EXECUTOR_PORT}/capabilities`, {}, 5000);
    capabilitiesSummary = (await rCap.json()).summary;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

wss.on('connection', (ws) => {
  ws.on('message', async (msg) => {
    try {
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
    } catch (e) { console.error("WS ERROR:", e); }
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
    const resList = await fetchWithTimeout(`${executorUrl}/list`, {}, 10000);
    const dataList = await resList.json();
    executorSkills = dataList.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    const resCap = await fetchWithTimeout(`${executorUrl}/capabilities`, {}, 10000);
    capabilitiesSummary = (await resCap.json()).summary;
    console.log(`${STYLES.green}Crisis Agent Connected.${STYLES.reset}`);
  } catch (e) { console.error(`${STYLES.red}Setup failed: ${e.message}${STYLES.reset}`); }
}

async function chat(input, images = [], files = []) {
  const userMsg = { role: 'user', content: input };
  if (images && images.length > 0) userMsg.images = images;
  if (files && files.length > 0) userMsg.files = files;
  if (input || images?.length || files?.length) history.push(userMsg);

  let lastFullResponse = null;
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
      console.log(`${STYLES.cyan}[CLI] LLM Request...${STYLES.reset}`);
      const response = await fetchWithTimeout(`${CONFIG.CLI_LLM.HOST}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: CONFIG.CLI_LLM.MODEL, messages: [{ role: 'system', content: systemPrompt }, ...formattedHistory], tools: executorSkills, think: CONFIG.CLI_THINK, stream: true }),
        signal: currentAbortController.signal
      }, 120000);

      const reader = response.body.getReader(), decoder = new TextDecoder();
      let fullContent = "", toolCalls = [], buffer = '', isThinking = false;
      broadcast({ type: 'stream_start' });

      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n'); buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.message?.thinking) {
              if (!isThinking) { process.stdout.write(`\n${STYLES.dim}[Thinking]\n `); isThinking = true; }
              process.stdout.write(data.message.thinking); broadcast({ type: 'thinking_chunk', content: data.message.thinking });
            }
            if (data.message?.content) {
              if (isThinking) { process.stdout.write(`${STYLES.reset}\n\n[Answer]\n`); isThinking = false; }
              process.stdout.write(data.message.content); broadcast({ type: 'stream_chunk', content: data.message.content });
              fullContent += data.message.content;
            }
            if (data.message?.tool_calls) toolCalls = toolCalls.concat(data.message.tool_calls);
            if (data.done) { totalPromptTokens += (data.prompt_eval_count || 0); totalResponseTokens += (data.eval_count || 0); broadcastConfig(); }
          } catch (e) {}
        }
      }

      if (toolCalls.length > 0) fullContent = ""; // 强制静言废话

      const assistantMsg = { role: 'assistant', content: fullContent };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      history.push(assistantMsg);

      if (toolCalls.length > 0) {
        for (const call of toolCalls) {
          let rawTask = call.function.arguments.task;
          const taskObj = { 
            result: true, message: (typeof rawTask === 'object') ? (rawTask.message || rawTask.instruction) : rawTask,
            attachment: files, data: { images: images.map(img => typeof img === 'string' ? img : img.data) } 
          };

          // 核心加固：打印向执行层发起的请求
          broadcast({ type: 'console_log', content: { "[CLI -> Executor REQUEST]": taskObj } });

          const res = await fetchWithTimeout(`http://localhost:${CONFIG.EXECUTOR_PORT}/call`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ arguments: { task: taskObj }, clientHost: EXTERNAL_HOST }),
            signal: currentAbortController.signal
          }, 300000);
          
          const skillData = await res.json();
          lastFullResponse = skillData;
          
          if (skillData.data?.tokens) { totalPromptTokens += skillData.data.tokens.prompt; totalResponseTokens += skillData.data.tokens.completion; broadcastConfig(); }
          if (skillData.data?.images) skillData.data.images.forEach(img => broadcast({ type: 'stream_image', data: img }));
          
          const resText = skillData.result ? skillData.message : `[ERROR] ${skillData.message}`;
          console.log(`\n${STYLES.dim}[Tool Result Received]${STYLES.reset}`);
          history.push({ role: 'tool', content: resText, tool_call_id: call.id });
        }
        continue;
      }
      break;
    } catch (e) {
      console.error(e);
      broadcast({ type: 'console_log', content: { "[CLI FATAL ERROR]": e.message, stack: e.stack } });
      break; 
    } finally { currentAbortController = null; }
  }
  broadcast({ type: 'stream_end', full_response: lastFullResponse });
}

async function processInput(line, source = 'terminal', images = [], files = []) {
  const input = line.trim(); if (!input && !images?.length && !files?.length) return;
  const log = (msg) => { console.log(msg); if (source === 'web') broadcast({ type: 'cli_result', content: msg }); };
  if (input === '/exit') process.exit(0);
  else if (input === '/clear') { console.clear(); broadcast({ type: 'clear' }); }
  else if (input === '/reset') { history = []; totalPromptTokens = 0; totalResponseTokens = 0; broadcast({ type: 'history', history: [] }); broadcastConfig(); log("Session Reset."); }
  else if (input === '/reboot') { setTimeout(() => process.exit(99), 500); }
  else if (input === '/context') { log(`History length: ${history.length}\nPrompt Tokens: ${totalPromptTokens}\nResponse Tokens: ${totalResponseTokens}`); }
  else if (input === '/system') { log(getSystemPrompt()); }
  else if (input === '/exe_system') {
    try { const r = await fetchWithTimeout(`http://localhost:${CONFIG.EXECUTOR_PORT}/system_prompt`, {}, 5000); const d = await r.json(); log(`Template:\n${d.template}\n\nEnv:\n${d.env_context}`); }
    catch(e) { log("Error: " + e.message); }
  }
  else if (input === '/skill_debug') {
    try {
      const rList = await fetchWithTimeout(`http://localhost:${CONFIG.EXECUTOR_PORT}/skills`, {}, 5000); const dList = await rList.json();
      const rMcp = await fetchWithTimeout(`http://localhost:${CONFIG.EXECUTOR_PORT}/mcp_tools`, {}, 5000); const dMcp = await rMcp.json();
      const mcpNames = [...dMcp.remote, ...dMcp.local].map(t => t.name);
      let out = ""; dList.skills.forEach(s => { const missing = s.use.filter(u => !mcpNames.includes(u)); out += `Skill [${s.name}]: ${missing.length > 0 ? "MISSING " + missing.join(', ') : "OK"}\n`; });
      log(out);
    } catch(e) { log("Debug failed."); }
  }
  else if (input.startsWith('/list')) {
    try {
      if (input.includes('skills')) {
        const r = await fetchWithTimeout(`http://localhost:${CONFIG.EXECUTOR_PORT}/skills`, {}, 5000); const d = await r.json();
        log(d.skills.map(s => `${s.name} [${s.enabled!==false?'ON':'OFF'}] - ${s.description}`).join('\n'));
      } else {
        const r = await fetchWithTimeout(`http://localhost:${CONFIG.EXECUTOR_PORT}/mcp_tools`, {}, 5000); const d = await r.json();
        log(`Remote Tools:\n` + d.remote.map(t=>`- ${t.name}`).join('\n') + `\nLocal Tools:\n` + d.local.map(t=>`- ${t.name}`).join('\n'));
      }
    } catch(e) { log("List failed."); }
  }
  else if (input.startsWith('/set')) {
    const parts = input.split(' ');
    if (parts[1] === 'skill') {
      const name = parts[2], status = parts[3] === 'on';
      await fetchWithTimeout(`http://localhost:${CONFIG.EXECUTOR_PORT}/set_skill_status`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, enabled: status }) }, 5000);
      log(`Skill ${name} set to ${parts[3]}`);
    } else if (parts[1] === 'cli_think' || parts[1] === 'exec_think') {
      const key = parts[1].toUpperCase(), status = parts[2] === 'on';
      CONFIG[key] = status; broadcastConfig(); log(`${parts[1]} is ${parts[2]}`);
    }
  }
  else if (input === '/help') {
    let help = `\n${STYLES.bold}=== HELP ===${STYLES.reset}\n/clear, /reset, /reboot, /exit, /context, /system, /exe_system, /skill_debug, /list skills, /list mcp functions, /set skill <name> <on/off>, /set <cli_think|exec_think> <on/off>\n`;
    log(help);
  }
  else { if (source === 'terminal') broadcast({ role: 'user', content: input }); await chat(input, images, files); }
}

process.on('unhandledRejection', (r) => {
  console.error("CLI UNHANDLED REJECTION:", r);
  broadcast({ type: 'console_log', content: { "[CLI FATAL REJECTION]": r.message, stack: r.stack } });
});

setup().then(() => {
  const port = CONFIG.CLI_PORT || 3002;
  server.listen(port, "0.0.0.0", () => console.log(`Web UI: http://localhost:${port}`));
  rl.on('line', l => processInput(l, 'terminal'));
  safePrompt();
});
