const express = require("express");
const fs = require('fs');
const path = require('path');
const cors = require("cors");
const crypto = require('crypto');

const CONFIG = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

const STYLES = { reset: '\x1b[0m', green: '\x1b[32m', cyan: '\x1b[36m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', yellow: '\x1b[33m' };

// 将日志同步发送给 CLI 的 Web 服务 (超短超时，绝不阻塞)
function relayLog(content, type = 'console_log') {
  const cleanText = content.replace(/\x1b\[[0-9;]*m/g, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 100);
  
  fetch(`http://localhost:3002/api/log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: cleanText, type }),
    signal: controller.signal
  }).catch(() => {}).finally(() => clearTimeout(timeout));
}

let skills = [];
let resourceTools = [];
let currentExpertAbortController = null;
let cachedEnvInfo = "System environment info not yet loaded.";

// 获取初始环境信息的内部函数
async function fetchInitialEnvInfo() {
  try {
    const res = await fetch(`${CONFIG.RESOURCE_MCP_URL}/call`, { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' }, 
      body: JSON.stringify({ name: 'get_env_info', arguments: {} }) 
    });
    const data = await res.json();
    if (data.content && data.content[0]) {
      cachedEnvInfo = data.content[0].text;
      console.log(`${STYLES.green}[Executor] System environment context loaded.${STYLES.reset}`);
    }
  } catch (e) {
    console.error(`${STYLES.red}[Executor] Failed to fetch initial environment: ${e.message}${STYLES.reset}`);
  }
}

// Executor 本地工具
const localTools = [
  {
    name: "read_local_file",
    description: "Read a file's text content from the local mcp_server folder.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    handler: async (args) => ({ content: [{ type: "text", text: fs.readFileSync(path.resolve(__dirname, 'mcp_server', args.path), 'utf8') }] })
  },
  {
    name: "write_local_file",
    description: "Write content to a file on the local machine.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    handler: async (args) => {
      const fullPath = path.resolve(args.path);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      let data = args.content;
      if (data.startsWith('BASE64_DATA:')) {
        data = Buffer.from(data.replace('BASE64_DATA:', ''), 'base64');
      }
      fs.writeFileSync(fullPath, data);
      return { content: [{ type: "text", text: `Successfully saved to ${fullPath}` }] };
    }
  },
  {
    name: "save_uploaded_image",
    description: "Save an image uploaded via WebUI/CLI to a local path. If no path provided, saves to 'uploads/'.",
    inputSchema: { 
      type: "object", 
      properties: { 
        image_index: { type: "integer", description: "Index of the image in the current message (0 for the first/only image)." },
        local_path: { type: "string", description: "Target local path (e.g., 'C:/my_images/test.jpg' or './uploads/test.jpg')." }
      }, 
      required: ["image_index"] 
    },
    handler: async (args, sessionImages) => {
      try {
        if (!sessionImages || sessionImages[args.image_index] === undefined) {
          throw new Error(`No image found at index ${args.image_index}.`);
        }

        let targetPath = args.local_path || args.path || args.destination;
        if (!targetPath) {
          const uploadsDir = path.join(process.cwd(), 'uploads');
          if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
          targetPath = path.join(uploadsDir, `upload_${Date.now()}.jpg`);
        } else if (targetPath.endsWith('/') || targetPath.endsWith('\\') || !path.extname(targetPath)) {
          fs.mkdirSync(targetPath, { recursive: true });
          targetPath = path.join(targetPath, `upload_${Date.now()}.jpg`);
        } else {
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        }
        
        const buffer = Buffer.from(sessionImages[args.image_index], 'base64');
        fs.writeFileSync(targetPath, buffer);
        
        return { content: [{ type: "text", text: `SUCCESS: Image saved to local path: ${targetPath}` }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `Save failed: ${e.message}` }] };
      }
    }
  },
  {
    name: "save_uploaded_file",
    description: "Save a non-image file uploaded via WebUI to a local path. If no path provided, saves to 'uploads/'.",
    inputSchema: { 
      type: "object", 
      properties: { 
        file_index: { type: "integer", description: "Index of the file in the current session (0 for the first file)." },
        local_path: { type: "string", description: "Target local path (e.g., 'D:/data/info.pdf')." }
      }, 
      required: ["file_index"] 
    },
    handler: async (args, sessionImages, sessionFiles) => {
      try {
        if (!sessionFiles || !sessionFiles[args.file_index]) throw new Error("No file found at that index.");
        const file = sessionFiles[args.file_index];
        
        let targetPath = args.local_path || args.path || args.destination;
        if (!targetPath) {
          const uploadsDir = path.join(process.cwd(), 'uploads');
          if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
          targetPath = path.join(uploadsDir, file.name);
        } else if (targetPath.endsWith('/') || targetPath.endsWith('\\') || !path.extname(targetPath)) {
          fs.mkdirSync(targetPath, { recursive: true });
          targetPath = path.join(targetPath, file.name);
        } else {
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        }

        fs.writeFileSync(targetPath, Buffer.from(file.data, 'base64'));
        return { content: [{ type: "text", text: `SUCCESS: File saved to local path: ${targetPath}` }] };
      } catch (e) { return { isError: true, content: [{ type: "text", text: e.message }] }; }
    }
  },
  {
    name: "list_local_tools",
    description: "List all tool script paths in the local mcp_server 'tools' directory.",
    inputSchema: { type: "object", properties: { } },
    handler: async () => 
    {
      const files = fs.readdirSync(path.join(__dirname, 'mcp_server', 'tools'));
      const paths = files.map(f => `tools/${f}`).join('\n');
      return { content: [{ type: "text", text: paths }] };
    }
  }
];

function loadSkills()
{
  const dir = path.join(__dirname, 'functions');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.func'));
  skills = [];
  for (const f of files) {
    try {
      skills.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    } catch(e) { console.error(`Error loading ${f}: ${e.message}`); }
  }
  const msg = `Loaded ${skills.length} skills.`;
  console.log(`${STYLES.green}${msg}${STYLES.reset}`);
  relayLog(msg);
}

async function syncResourceTools()
{
  try {
    const res = await fetch(`${CONFIG.RESOURCE_MCP_URL}/list`);
    const data = await res.json();
    resourceTools = data.tools;
    const msg = `Synced ${resourceTools.length} tools.`;
    console.log(`${STYLES.green}${msg}${STYLES.reset}`);
    relayLog(msg);
  } catch (e) { console.error(`Resource MCP Error: ${e.message}`); }
}

async function runStatelessLLM(skill, userInstruction, images = [], files = [])
{
  const currentConfig = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  const allAvailableTools = [...resourceTools, ...localTools];
  
  // 筛选该技能授权的工具，并强制加入 MCP 原生的 get_tool_usage 供专家自查
  const authorizedNames = [...skill.use, "get_tool_usage"];
  const authorizedToolsRaw = allAvailableTools.filter(t => authorizedNames.includes(t.name));
  
  // 核心：强制执行“先研究再执行”协议
  const authorizedTools = authorizedToolsRaw.map(t => {
    if (t.name === "get_tool_usage") {
      // 只有查询工具保留完整 Schema
      return { type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } };
    } else {
      // 其他工具只提供名字和描述，将参数定义设为“待查阅”状态
      // 使用一个允许任何属性的空 Schema 诱导模型去查询，或者明确告诉它参数是隐藏的
      return { 
        type: 'function', 
        function: { 
          name: t.name, 
          description: `${t.description} (SCHEMA HIDDEN: Call 'get_tool_usage' to unlock parameters)`, 
          parameters: { type: "object", properties: {}, additionalProperties: true } 
        } 
      };
    }
  });

  // 从 exe_system.md 动态加载并替换变量
  let expertSystemPrompt = "";
  try {
    const template = fs.readFileSync('exe_system.md', 'utf8');
    expertSystemPrompt = template.replace('{{skill_system}}', skill.system);
    // 注入当前系统环境上下文
    expertSystemPrompt += `\n\n### CURRENT SYSTEM ENVIRONMENT CONTEXT\n${cachedEnvInfo}`;
  } catch (e) {
    // 降级方案
    expertSystemPrompt = `${skill.system}\n\n### CURRENT SYSTEM ENVIRONMENT CONTEXT\n${cachedEnvInfo}\n\n### MANDATORY ARCHITECTURAL PROTOCOL\n1. TOOL DISCOVERY: To minimize errors, tool parameters are HIDDEN by default. \n2. RESEARCH REQUIREMENT: You MUST call 'get_tool_usage' for any tool you wish to use. This will return the correct JSON Schema.\n3. ZERO GUESSING: Do not attempt to guess parameters. If you call a tool with incorrect or guessed arguments, the system will reject it.\n4. RESILIENCE: If a tool call is BLOCKED or rejected, DO NOT give up. Read the returned hint and RETRY immediately.`;
  }

  let userMsg = { role: 'user', content: userInstruction };
  if (images && images.length > 0) userMsg.images = images;

  let messages = [
    { role: 'system', content: expertSystemPrompt },
    userMsg
  ];

  let promptTokens = 0;
  let completionTokens = 0;
  let capturedImages = [];

  try {
    while (true)
    {
      currentExpertAbortController = new AbortController();
      const response = await fetch(`${CONFIG.EXECUTOR_LLM.HOST}/api/chat`, 
      {
        method: 'POST',
        body: JSON.stringify({ model: CONFIG.EXECUTOR_LLM.MODEL, messages, tools: authorizedTools, think: false, stream: true }),
        signal: currentExpertAbortController.signal
      });
      
      if (!response.ok) throw new Error(`LLM API returned ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";
      let toolCalls = [];
      let buffer = '';

      relayLog('[Executor]');
      while (true)
      {
        try {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines)
          {
            if (!line.trim()) continue;
            try {
              const data = JSON.parse(line);
              const message = data.message;

              if (message?.thinking) {
                if (currentConfig.EXECUTOR_THINK) relayLog(message.thinking, 'thinking_chunk');
                continue;
              }

              if (message?.content) {
                let content = message.content;
                relayLog(content, 'console_log_stream');
                fullContent += content;
              }

              if (data.message?.tool_calls) toolCalls = toolCalls.concat(data.message.tool_calls);

              if (data.done) {
                if (data.prompt_eval_count) promptTokens += data.prompt_eval_count;
                if (data.eval_count) completionTokens += data.eval_count;
              }
            } catch (e) {}
          }
        } catch (e) {
          if (e.name === 'AbortError') throw e; 
          break;
        }
      }

      const assistantMsg = { role: 'assistant', content: fullContent };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      messages.push(assistantMsg);

      if (toolCalls.length > 0)
      {
        for (const call of toolCalls)
        {
          const argsString = JSON.stringify(call.function.arguments);
          const toolLog = `[Executor] Tool Call: ${call.function.name} (${argsString})`;
          console.log(`${STYLES.dim}${toolLog}${STYLES.reset}`);
          relayLog(toolLog);

          let toolData;
          const localTool = localTools.find(t => t.name === call.function.name);
          if (localTool) toolData = await localTool.handler(call.function.arguments, images, files);
          else {
            const toolRes = await fetch(`${CONFIG.RESOURCE_MCP_URL}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: call.function.name, arguments: call.function.arguments }) });
            toolData = await toolRes.json();
          }

          const text = toolData.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
          const capturedImagesFromTool = toolData.content.filter(c => c.type === 'image').map(c => c.data);

          // 打印工具执行结果
          const resultPreview = text.length > 500 ? text.substring(0, 500) + "..." : text;
          const resultLog = `[Tool Result] ${call.function.name}: ${resultPreview}${capturedImagesFromTool.length > 0 ? ` (+${capturedImagesFromTool.length} images)` : ''}`;
          console.log(`${STYLES.dim}${resultLog}${STYLES.reset}`);
          relayLog(resultLog);

          if (capturedImagesFromTool && capturedImagesFromTool.length > 0) capturedImages = capturedImages.concat(capturedImagesFromTool);
          
          messages.push({ role: 'tool', content: text, tool_call_id: call.id });
          
          if (capturedImagesFromTool && capturedImagesFromTool.length > 0) {
            messages.push({ role: 'user', content: "Attached captured visuals.", images: capturedImagesFromTool });
          }
          
        }
        continue;
      }
      return { content: fullContent, tokens: { prompt: promptTokens, completion: completionTokens }, images: capturedImages };
    }
  } catch (e) {
    if (e.name === 'AbortError') return { content: "--- Expert Inference Terminated ---", tokens: { prompt: 0, completion: 0 } };
    throw e;
  } finally {
    currentExpertAbortController = null;
  }
}

app.post("/call", async (req, res) => 
{
  const { name, arguments: args, skill_name, images, files } = req.body;
  
  if (files && files.length > 0) {
    relayLog(`[DEBUG] /call received ${files.length} files`);
  }

  if (skill_name) {
    const targetSkill = skills.find(s => s.name === skill_name);
    if (!targetSkill) return res.status(404).json({ error: `Skill '${skill_name}' not found.` });
    const instruction = args?.task || `Perform ${skill_name}`;
    const expertRes = await runStatelessLLM(targetSkill, instruction, images, files);
    return res.json({ content: [{ type: "text", text: expertRes.content }], tokens: { prompt: expertRes.tokens.prompt, completion: expertRes.tokens.completion }, images: expertRes.images || [] });
  }

  if (name !== "delegate_task") return res.status(404).json({ error: "Only delegate_task allowed" });

  const instruction = args.task;
  const delegateLog = `[DELEGATE] Task: ${instruction}`;
  console.log(`${STYLES.bold}${delegateLog}${STYLES.reset}`);
  relayLog(delegateLog);
  
  const currentConfig = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  let totalPrompt = 0;
  let totalCompletion = 0;
  const enabledSkills = getEnabledSkills();

  try
  {
    let contextHint = "";
    if (files && files.length > 0) contextHint += `\n[Context: ${files.length} file(s) attached to session]`;
    if (images && images.length > 0) contextHint += `\n[Context: ${images.length} image(s) attached to session]`;

    const skillSpecs = enabledSkills.map(s => `- ${s.name}: ${s.description}`).join('\n');
    const routerPrompt = `Task: "${instruction}"${contextHint}\n\nChoose the MOST SPECIFIC skill from the following list:\n${skillSpecs}\n\nOutput ONLY the skill name. If no suitable match exists, output 'NONE'.`;
    const routerResponse = await fetch(`${CONFIG.EXECUTOR_LLM.HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: CONFIG.EXECUTOR_LLM.MODEL, messages: [{ role: 'user', content: routerPrompt, images: images }], think: false ,stream: false, options: { temperature: 0 } })
    });

    const routerData = await routerResponse.json();
    const decision = routerData.message.content.trim();
    
    if (decision) {
      const decisionLog = `[Dispatcher] Decision: ${decision}`;
      console.log(`${STYLES.yellow}${decisionLog}${STYLES.reset}\n`);
      relayLog(decisionLog);
    }

    if (decision.startsWith("NONE") || !enabledSkills.find(s => s.name === decision)) {
      return res.json({ content: [{ type: "text", text: "No suitable skill found." }], tokens: { prompt: totalPrompt, completion: totalCompletion } });
    }

    const bestSkill = enabledSkills.find(s => s.name === decision);
    const expertRes = await runStatelessLLM(bestSkill, instruction, images, files);
    res.json({ content: [{ type: "text", text: expertRes.content }], tokens: { prompt: expertRes.tokens.prompt, completion: expertRes.tokens.completion }, images: expertRes.images || [] });
  }
  catch (e) {
    console.error(`[ERROR] ${e.message}`);
    relayLog(`Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.get("/list", (req, res) => {
  res.json({ tools: [{ name: "delegate_task", description: "Delegate task", inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] } }] });
});
app.get("/skills", (req, res) => res.json({ skills }));
app.get("/mcp_tools", (req, res) => res.json({ remote: resourceTools, local: localTools }));
app.post("/set_skill_status", (req, res) => {
  const { name, enabled } = req.body;
  const filePath = path.join(__dirname, 'functions', `${name}.func`);
  const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  content.enabled = enabled;
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
  loadSkills();
  res.json({ message: "OK" });
});
app.get("/capabilities", (req, res) => { res.json({ summary: "Domains: File, Screen, Info, Scripting, Control." }); });
app.get("/system_prompt", (req, res) => {
  try {
    const template = fs.readFileSync('exe_system.md', 'utf8');
    res.json({ template, env_context: cachedEnvInfo });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/reboot", (req, res) => { res.json({ message: "OK" }); setTimeout(() => process.exit(99), 100); });

app.post("/interrupt", (req, res) => {
  if (currentExpertAbortController) {
    currentExpertAbortController.abort();
    currentExpertAbortController = null;
    console.log(`${STYLES.yellow}[Executor] Expert inference interrupted by command.${STYLES.reset}`);
    return res.json({ message: "Interrupted" });
  }
  res.json({ message: "No active inference" });
});

function getEnabledSkills() { return skills.filter(s => s.enabled !== false); }

async function start() {
  loadSkills();
  await syncResourceTools();
  await fetchInitialEnvInfo(); // 启动时获取系统环境
  const msg = `Executor ready on ${CONFIG.EXECUTOR_PORT}`;
  app.listen(CONFIG.EXECUTOR_PORT, "0.0.0.0", () => {
    console.log(msg);
    relayLog(msg);
  });
}
start();
