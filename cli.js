const readline = require('readline');
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const CONFIG = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const STYLES = { 
  reset: '\x1b[0m', 
  cyan: '\x1b[36m', 
  bold: '\x1b[1m', 
  green: '\x1b[32m', 
  dim: '\x1b[2m', 
  yellow: '\x1b[33m',
  bgCyan: '\x1b[46m',
  bgGreen: '\x1b[42m',
  white: '\x1b[37m',
  red: '\x1b[31m'
};
const rl = readline.createInterface({ 
  input: process.stdin, 
  output: process.stdout, 
  prompt: `\n${STYLES.bgGreen}${STYLES.white}${STYLES.bold} USER ${STYLES.reset} ` 
});

let history = [];
let executorSkills = [];
let capabilitiesSummary = "";
let totalPromptTokens = 0;
let totalResponseTokens = 0;
let currentAbortController = null;

function safePrompt() {
  if (rl && !rl.closed) {
    try { rl.prompt(); } catch (e) {}
  }
}

// Web Server Setup
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// API 路由
app.post('/api/log', (req, res) => {
  const { content, type } = req.body;
  logToWeb(content, type);
  res.sendStatus(200);
});

app.post('/api/save_attachment', (req, res) => {
  try {
    const { name, data, type } = req.body;
    if (!name || !data) return res.status(400).json({ error: 'Missing name or data' });

    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    const filePath = path.join(uploadsDir, name);
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
    
    console.log(`${STYLES.green}[Storage] File saved (Base64): ${filePath}${STYLES.reset}`);
    res.json({ success: true, path: filePath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 流式二进制上传接口
app.post('/api/upload_binary', (req, res) => {
  const rawFileName = req.headers['x-file-name'];
  if (!rawFileName) return res.status(400).json({ error: 'Missing x-file-name header' });

  const fileName = decodeURIComponent(rawFileName);
  const uploadsDir = path.join(__dirname, 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  const filePath = path.join(uploadsDir, fileName);
  const writeStream = fs.createWriteStream(filePath);

  req.pipe(writeStream);

  writeStream.on('finish', () => {
    console.log(`${STYLES.green}[Storage] File saved (Stream): ${filePath}${STYLES.reset}`);
    res.json({ success: true, path: filePath });
  });

  writeStream.on('error', (err) => {
    console.error(`${STYLES.red}[Storage] Stream Save Error: ${err.message}${STYLES.reset}`);
    res.status(500).json({ error: err.message });
  });
});

app.get('/api/skills', async (req, res) => {
  try {
    const response = await fetch(`http://localhost:${CONFIG.EXECUTOR_PORT}/skills`);
    const data = await response.json();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/set_skill', async (req, res) => {
  try {
    const { name, enabled } = req.body;
    const response = await fetch(`http://localhost:${CONFIG.EXECUTOR_PORT}/set_skill_status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, enabled })
    });
    const data = await response.json();
    const resCap = await fetch(`http://localhost:${CONFIG.EXECUTOR_PORT}/capabilities`);
    const dataCap = await resCap.json();
    capabilitiesSummary = dataCap.summary;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use(express.static(path.join(__dirname, 'web')));

wss.on('connection', (ws) => {
  ws.on('message', async (msg) => {
    const data = JSON.parse(msg);
    if (data.type === 'chat') {
      // 提取图片数据和名字
      let processedImages = [];
      let imageNames = [];
      if (data.images) {
        data.images.forEach(img => {
          if (typeof img === 'string') processedImages.push(img);
          else {
            processedImages.push(img.data);
            if (img.name) imageNames.push(img.name);
          }
        });
      }

      const logText = (processedImages.length > 0 || data.files?.length > 0) ? `${data.content} [+Attachment]` : data.content;
      console.log(`\n${STYLES.bgGreen}${STYLES.white}${STYLES.bold} USER (Web) ${STYLES.reset} ${logText}`);
      
      await processInput(data.content, 'web', processedImages, data.files, imageNames);
      if (data.content !== '/reboot' && data.content !== '/exit') safePrompt();
    }
    else if (data.type === 'stop') {
      if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
        fetch(`http://localhost:${CONFIG.EXECUTOR_PORT}/interrupt`, { method: 'POST' }).catch(() => {});
        console.log(`${STYLES.yellow}[CLI] Inference terminated by user.${STYLES.reset}`);
        logToWeb("--- Inference Terminated ---");
        broadcast({ type: 'stream_end' });
      }
    }
  });
  ws.send(JSON.stringify({ type: 'history', history }));
  broadcastConfig();
  broadcastConfig();
});

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  });
}

function broadcastConfig() {
  broadcast({ 
    type: 'config', 
    cli_think: CONFIG.CLI_THINK, 
    exec_think: CONFIG.EXECUTOR_THINK,
    cli_model: `${CONFIG.CLI_LLM.MODEL} (${CONFIG.CLI_LLM.HOST})`,
    exec_model: `${CONFIG.EXECUTOR_LLM.MODEL} (${CONFIG.EXECUTOR_LLM.HOST})`,
    tokens: {
      total: totalPromptTokens + totalResponseTokens,
      prompt: totalPromptTokens,
      response: totalResponseTokens
    }
  });
}

function logToWeb(content, type = 'console_log') {
  const cleanText = content.replace(/\x1b\[[0-9;]*m/g, '');
  broadcast({ type, content: cleanText });
}

function getSystemPrompt() {
  let prompt = fs.existsSync('system.md') ? fs.readFileSync('system.md', 'utf8') : "";
  if (capabilitiesSummary) {
    prompt += `\n\n### System Capabilities (Executor):\n${capabilitiesSummary}\n\nIMPORTANT: Use 'delegate_task' for system actions. Pass user instruction exactly as is.`;
  }
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
    console.log(`${STYLES.green}Crisis Agent Connected. Type /help for commands.${STYLES.reset}`);
  } catch (e) { console.error("Executor connection failed:", e.message); }
}

async function chat(input, images = [], files = [], imageNames = []) {
  const userMsg = { role: 'user', content: input };
  if (images && images.length > 0) userMsg.images = images;
  if (files && files.length > 0) userMsg.files = files; // 存入历史记录
  if (input || (images && images.length > 0) || (files && files.length > 0)) history.push(userMsg);

  while (true) {
    currentAbortController = new AbortController();
    let systemPrompt = getSystemPrompt();
    
    // 如果当前轮次包含图片或文件，强制要求委派并明确语义
    if ((images && images.length > 0) || (files && files.length > 0)) {
      systemPrompt += "\n\nCRITICAL: The current message contains attachments (images/files). You MUST use 'delegate_task' to pass the user request to the Executor.";
      systemPrompt += "\nNOTE: For analysis/vision tasks, the Executor will automatically receive these attachments in its context. DO NOT ask to 'save' them unless the user specifically uses words like 'Save', 'Push', 'Store' or 'Download'.";
    }

    const messages = [{ role: 'system', content: systemPrompt }, ...history.filter(m => m.role !== 'system')];
    
    try {
      const response = await fetch(`${CONFIG.CLI_LLM.HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: CONFIG.CLI_LLM.MODEL, messages, tools: executorSkills, think: CONFIG.CLI_THINK, stream: true }),
        signal: currentAbortController.signal
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: "Ollama Error" }));
        console.error(`\n${STYLES.red}[Ollama Error] ${err.error}${STYLES.reset}`);
        broadcast({ type: 'stream_end' });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";
      let toolCalls = [];
      let buffer = '';
      let isThinking = false;
      let hasPrintedPrompt = false;

      broadcast({ type: 'stream_start' });

      while (true) {
        try {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const data = JSON.parse(line);
              const msg = data.message;

              if (msg?.thinking) {
                if (!hasPrintedPrompt) { process.stdout.write(`\n${STYLES.bgCyan}${STYLES.white}${STYLES.bold} CrisisAgent ${STYLES.reset} `); hasPrintedPrompt = true; }
                if (!isThinking) { process.stdout.write(`\n${STYLES.dim}[Thinking]\n `); isThinking = true; }
                process.stdout.write(msg.thinking);
                broadcast({ type: 'thinking_chunk', content: msg.thinking });
              }

              if (msg?.content) {
                if (!hasPrintedPrompt) { process.stdout.write(`\n${STYLES.bgCyan}${STYLES.white}${STYLES.bold} CrisisAgent ${STYLES.reset} `); hasPrintedPrompt = true; }
                if (isThinking) { process.stdout.write(`${STYLES.reset}\n\n[Answer]\n`); isThinking = false; }
                process.stdout.write(msg.content);
                broadcast({ type: 'stream_chunk', content: msg.content });
                fullContent += msg.content;
              }

              if (msg?.tool_calls) toolCalls = toolCalls.concat(msg.tool_calls);

              if (data.done) {
                if (data.prompt_eval_count) totalPromptTokens += data.prompt_eval_count;
                if (data.eval_count) totalResponseTokens += data.eval_count;
                broadcastConfig();
              }
            } catch (e) {}
          }
        } catch (e) {
          if (e.name === 'AbortError') { broadcast({ type: 'stream_end' }); return; }
          throw e;
        }
      }

      const assistantMsg = { role: 'assistant', content: fullContent };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      history.push(assistantMsg);

      if (toolCalls.length > 0) {
              for (const call of toolCalls) {
                try {
                  let taskInstruction = call.function.arguments.task;
                  
                  // 附件追溯逻辑：如果当前没有新附件，尝试从历史记录中寻找最近的附件
                  let activeImages = images && images.length > 0 ? images : [];
                  let activeFiles = files && files.length > 0 ? files : [];
                  let activeImageNames = imageNames && imageNames.length > 0 ? imageNames : [];

                  if (activeImages.length === 0 || activeFiles.length === 0) {
                    for (let i = history.length - 1; i >= 0; i--) {
                      const msg = history[i];
                      if (activeImages.length === 0 && msg.images && msg.images.length > 0) {
                        activeImages = msg.images;
                      }
                      if (activeFiles.length === 0 && msg.files && msg.files.length > 0) {
                        activeFiles = msg.files;
                      }
                      if (activeImages.length > 0 && activeFiles.length > 0) break;
                    }
                  }

                  // 如果有附件，在指令头部注入元数据提示
                  if (activeFiles.length > 0) {
                    const fileList = activeFiles.map(f => f.name).join(', ');
                    taskInstruction = `[SESSION_FILES: ${fileList}] ${taskInstruction}`;
                  }
                  if (activeImages.length > 0) {
                    const nameList = activeImageNames.join(', ') || 'unnamed';
                    taskInstruction = `[SESSION_IMAGES: ${nameList}] ${taskInstruction}`;
                  }
                  
                  const logMsg = `[CLI] Routing to Executor: ${call.function.name}`;
                  console.log(`\n${STYLES.dim}${logMsg}${STYLES.reset}`);
                  logToWeb(logMsg);
        
                  const res = await fetch(`http://localhost:${CONFIG.EXECUTOR_PORT}/call`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                      name: call.function.name, 
                      arguments: { ...call.function.arguments, task: taskInstruction },
                      images: activeImages, // 使用追溯后的附件
                      files: activeFiles    // 使用追溯后的附件
                    }),
                    signal: currentAbortController.signal
                  });
        
            const skillData = await res.json();
            
            if (skillData.tokens) {
              totalPromptTokens += (skillData.tokens.prompt || 0);
              totalResponseTokens += (skillData.tokens.completion || 0);
              broadcastConfig();
            }

                      if (skillData.images) {
                        skillData.images.forEach(img => broadcast({ type: 'stream_image', data: img }));
                      }
            
                      if (skillData.error || skillData.isError) {
                        const errorText = `[TOOL ERROR] ${skillData.error || skillData.content?.[0]?.text || "Unknown error"}`;
                        console.log(`\n${STYLES.red}${errorText}${STYLES.reset}`);
                        logToWeb(errorText);
                        history.push({ role: 'tool', content: errorText, tool_call_id: call.id });
                      } else {
                        const resultText = skillData.content?.[0]?.text || "(Done)";
                        const resultLog = `[Tool Result]: ${resultText.substring(0, 200)}${resultText.length > 200 ? '...' : ''}`;
                        console.log(`${STYLES.dim}${resultLog}${STYLES.reset}`);
                        history.push({ role: 'tool', content: resultText, tool_call_id: call.id });
                      }
                    } catch (err) {
                      if (err.name === 'AbortError') throw err;
                      const fatalError = `[CLI ERROR] Failed to connect to Executor: ${err.message}`;
                      console.error(`\n${STYLES.red}${fatalError}${STYLES.reset}`);
                      logToWeb(fatalError);
                      history.push({ role: 'tool', content: fatalError, tool_call_id: call.id });
                    }
            
        }
        continue;
      }
      break;
    } catch (e) {
      if (e.name === 'AbortError') break;
      console.error("Chat Error:", e.message);
      break;
    } finally {
      currentAbortController = null;
    }
  }
  broadcast({ type: 'stream_end' });
}

async function processInput(line, source = 'terminal', images = [], files = [], imageNames = []) {
  const input = line.trim();
  if (!input && (!images || images.length === 0) && (!files || files.length === 0)) return;
  if (source === 'terminal') broadcast({ role: 'user', content: input });

  if (input === '/exit') process.exit(0);
  else if (input === '/clear') {
    console.clear();
    broadcast({ type: 'clear' });
    broadcast({ type: 'stream_end' });
  }
  else if (input === '/reset') {
    history = []; totalPromptTokens = 0; totalResponseTokens = 0;
    broadcast({ type: 'history', history: [] }); broadcastConfig();
    console.log('Session Reset.');
    broadcast({ type: 'stream_end' });
  }
  else if (input === '/context') {
    let report = `=== CONTEXT HISTORY ===\n`;
    history.forEach((m, i) => {
      report += `[${i}] ${m.role.toUpperCase()}:\n${m.content || '[Tool Call]'}\n---\n`;
    });
    report += `Total Tokens: ${totalPromptTokens + totalResponseTokens}`;
    console.log(`${STYLES.cyan}\n${report}${STYLES.reset}`);
    if (source === 'web') logToWeb(report);
    broadcast({ type: 'stream_end' });
  }
  else if (input === '/system') {
    const systemContent = getSystemPrompt();
    let report = `=== SYSTEM PROMPT (CLI) ===\n${systemContent}\n-----------------------`;
    console.log(`${STYLES.cyan}\n${report}${STYLES.reset}`);
    if (source === 'web') logToWeb(report);
    try {
      const probeRes = await fetch(`${CONFIG.CLI_LLM.HOST}/api/generate`, { method: 'POST', body: JSON.stringify({ model: CONFIG.CLI_LLM.MODEL, system: systemContent, prompt: "", stream: false }) });
      const probeData = await probeRes.json();
      const tokenInfo = `Current CLI System Prompt Cost: ${probeData.prompt_eval_count || 0} Tokens`;
      console.log(`${STYLES.green}${tokenInfo}${STYLES.reset}`);
      if (source === 'web') logToWeb(tokenInfo);
    } catch (e) {}
    broadcast({ type: 'stream_end' });
  }
  else if (input === '/exe_system') {
    try {
      const res = await fetch(`http://localhost:${CONFIG.EXECUTOR_PORT}/system_prompt`);
      const data = await res.json();
      let report = `=== EXECUTOR SYSTEM PROMPT TEMPLATE ===\n${data.template}\n\n=== CACHED ENV CONTEXT ===\n${data.env_context}\n-----------------------`;
      console.log(`${STYLES.cyan}\n${report}${STYLES.reset}`);
      if (source === 'web') logToWeb(report);
    } catch (e) {
      logToWeb(`Error fetching executor prompt: ${e.message}`);
    }
    broadcast({ type: 'stream_end' });
  }
  else if (input === '/reboot') {
    console.log('Rebooting...');
    broadcast({ type: 'reboot' });
    setTimeout(async () => {
      try { await fetch(`http://localhost:${CONFIG.EXECUTOR_PORT}/reboot`, { method: 'POST' }); } catch (e) {}
      process.exit(99);
    }, 500);
  }
  else if (input === '/help') {
    let helpMsg = `\n${STYLES.bold}${STYLES.cyan}=== CRISIS AGENT COMPREHENSIVE HELP ===${STYLES.reset}\n\n` +
      `${STYLES.bold}[ 会话管理 (Session) ]${STYLES.reset}\n` +
      `  /clear          - 清除终端屏幕内容\n` +
      `  /reset          - 重置当前对话历史，清空 Token 计数\n` +
      `  /reboot         - 重新启动整个系统（CLI + Executor）\n` +
      `  /exit           - 退出 Crisis Agent\n\n` +
      `${STYLES.bold}[ 调试与监控 (Debugging) ]${STYLES.reset}\n` +
      `  /context        - 显示当前对话的上下文历史及 Token 消耗详情\n` +
      `  /system         - 查看当前的系统提示词 (System Prompt) 及其 Token 成本\n` +
      `  /skill_debug    - 诊断 Skill 状态，检查依赖的 MCP 原子功能是否缺失\n\n` +
      `${STYLES.bold}[ 系统与 Skill 管理 (System & Skills) ]${STYLES.reset}\n` +
      `  /list skills             - 列出所有可用 Skill 及其开启/关闭状态\n` +
      `  /list mcp functions      - 列出 Executor 及其关联 MCP Server 的所有底层原子工具\n` +
      `  /set skill <name> <on/off> - 动态开启或关闭指定的 Skill (例如: /set skill downloader off)\n\n` +
      `${STYLES.bold}[ 配置选项 (Configuration) ]${STYLES.reset}\n` +
      `  /set cli_think <on/off>  - 开启/关闭 CLI 层级的思考过程 (CoT) 显示\n` +
      `  /set exec_think <on/off> - 开启/关闭 Executor 层级的思考过程 (CoT) 显示\n\n` +
      `${STYLES.dim}提示: 直接输入自然语言即可开始与 AI 协作，AI 会根据需要自动调用上述 Skill。${STYLES.reset}\n`;
    console.log(helpMsg);
    if (source === 'web') logToWeb(helpMsg);
    broadcast({ type: 'stream_end' });
  }
  else if (input === '/skill_debug') {
    try {
      const resSkills = await fetch(`http://localhost:${CONFIG.EXECUTOR_PORT}/skills`);
      const dataSkills = await resSkills.json();
      const resTools = await fetch(`http://localhost:${CONFIG.EXECUTOR_PORT}/mcp_tools`);
      const dataTools = await resTools.json();
      const allTools = [...(dataTools.remote || []), ...(dataTools.local || [])];
      let report = `=== NATIVE SKILL DEBUGGER ===\n\n`;
      dataSkills.skills.forEach(s => {
        const status = s.enabled !== false ? '✅ [ENABLED]' : '❌ [DISABLED]';
        report += `${status} ${s.name.toUpperCase()}\nDescription: ${s.description}\nAuthorized Tools: ${s.use.join(', ') || '(None)'}\n`;
        const missingTools = s.use.filter(u => !allTools.find(t => t.name === u));
        if (missingTools.length > 0) report += `⚠️  MISSING TOOLS: ${missingTools.join(', ')}\n`;
        report += `-----------------------------------\n`;
      });
      console.log(`${STYLES.yellow}${report}${STYLES.reset}`);
      if (source === 'web') logToWeb(report);
    } catch (err) { logToWeb(`Skill Debug Error: ${err.message}`); }
    broadcast({ type: 'stream_end' });
  }
  else if (input === '/list skills') {
    try {
      const res = await fetch(`http://localhost:${CONFIG.EXECUTOR_PORT}/skills`);
      const data = await res.json();
      let list = data.skills.map(s => `${s.enabled!==false?'[ON]':'[OFF]'} ${s.name}: ${s.description}`).join('\n');
      console.log(list); if (source === 'web') logToWeb(list);
    } catch(e) {}
    broadcast({ type: 'stream_end' });
  }
  else if (input === '/list mcp functions') {
    try {
      const res = await fetch(`http://localhost:${CONFIG.EXECUTOR_PORT}/mcp_tools`);
      const data = await res.json();
      const allTools = [...(data.remote || []), ...(data.local || [])];
      let list = `=== MCP ATOMIC FUNCTIONS ===\n\n` + allTools.map(t => `- ${t.name}: ${t.description}`).join('\n');
      console.log(list); if (source === 'web') logToWeb(list);
    } catch(e) {}
    broadcast({ type: 'stream_end' });
  }
  else if (input.startsWith('/set skill ')) {
    const p = input.split(' ');
    await fetch(`http://localhost:${CONFIG.EXECUTOR_PORT}/set_skill_status`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name: p[2], enabled: p[3]==='on'||p[3]==='enabled'}) });
    logToWeb(`Skill '${p[2]}' updated.`);
    broadcast({ type: 'stream_end' });
  }
  else if (input.startsWith('/set cli_think ')) {
    CONFIG.CLI_THINK = input.includes('on');
    fs.writeFileSync('config.json', JSON.stringify(CONFIG, null, 2), 'utf8');
    logToWeb(`CLI Thinking: ${CONFIG.CLI_THINK ? 'ON' : 'OFF'}`);
    broadcastConfig();
    broadcast({ type: 'stream_end' });
  }
  else if (input.startsWith('/set exec_think ')) {
    CONFIG.EXECUTOR_THINK = input.includes('on');
    fs.writeFileSync('config.json', JSON.stringify(CONFIG, null, 2), 'utf8');
    logToWeb(`Executor Thinking: ${CONFIG.EXECUTOR_THINK ? 'ON' : 'OFF'}`);
    broadcastConfig();
    broadcast({ type: 'stream_end' });
  }
  else await chat(input, images, files, imageNames);
}

async function main() {
  const WEB_PORT = 3002;
  server.listen(WEB_PORT, () => {
    const msg = `[Web] active at http://localhost:${WEB_PORT}`;
    console.log(msg);
    logToWeb(msg);
  });
  process.stdout.write('\x1b[2 q\x1b]12;#bbbbbb\x07');
  await setup();
  safePrompt();
  rl.on('line', async (line) => { 
    await processInput(line, 'terminal'); 
    if (line.trim() !== '/reboot' && line.trim() !== '/exit') safePrompt(); 
  });
}
main();
