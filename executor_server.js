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
let executionCounter = 0;

async function fetchInitialEnvInfo() {
  try {
    const res = await fetch(`${CONFIG.RESOURCE_MCP_URL}/call`, { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' }, 
      body: JSON.stringify({ name: 'get_env_info', arguments: {}, execution_id: -1 }) 
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
    description: "Save an image uploaded via WebUI/CLI to a local path.",
    inputSchema: { 
      type: "object", 
      properties: { 
        image_index: { type: "integer" },
        local_path: { type: "string" }
      }
    },
    handler: async (args, sessionImages) => {
      try {
        let idx = args.image_index;
        if (idx === undefined && sessionImages && sessionImages.length === 1) idx = 0;
        if (!sessionImages || idx === undefined || !sessionImages[idx]) throw new Error("Image not found");
        const imgObj = sessionImages[idx];
        const base64Data = typeof imgObj === 'string' ? imgObj : imgObj.data;
        const targetPath = path.resolve(args.local_path || `uploads/image_${Date.now()}.jpg`);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, Buffer.from(base64Data, 'base64'));
        return { content: [{ type: "text", text: `SUCCESS: Image saved to ${targetPath}` }] };
      } catch (e) { return { isError: true, content: [{ type: "text", text: e.message }] }; }
    }
  },
  {
    name: "get_tool_usage",
    description: "Retrieve tool schema. Mandatory before use.",
    inputSchema: { type: "object", properties: { tool_name: { type: "string" }, execution_id: { type: "integer" } }, required: ["tool_name"] },
    handler: async (args) => {
      const localTarget = localTools.find(t => t.name === args.tool_name);
      if (localTarget) return { content: [{ type: "text", text: JSON.stringify(localTarget.inputSchema) }] };
      const toolRes = await fetch(`${CONFIG.RESOURCE_MCP_URL}/call`, { 
        method: 'POST', headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ name: 'get_tool_usage', arguments: { tool_name: args.tool_name }, execution_id: args.execution_id }) 
      });
      return await toolRes.json();
    }
  }
];

function loadSkills() {
  const dir = path.join(__dirname, 'functions');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.func'));
  skills = [];
  for (const f of files) {
    try { skills.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch(e) {}
  }
}

async function syncResourceTools() {
  try {
    const res = await fetch(`${CONFIG.RESOURCE_MCP_URL}/list`);
    const data = await res.json();
    resourceTools = data.tools;
  } catch (e) {}
}

function getEnabledSkills() { return skills.filter(s => s.enabled !== false); }

async function runPlanner(instructionJSON, enabledSkills, files, images) {
  const skillSpecs = enabledSkills.map(s => `- ${s.name}: ${s.description}`).join('\n');
  const plannerPrompt = `Task JSON: ${JSON.stringify(instructionJSON)}\n\n作为 Planner，请选择专家并拆解步骤。必须返回 JSON：{"expert": "...", "goal": "...", "plan": ["..."]}`;
  const formattedImages = images ? images.map(img => typeof img === 'string' ? img : img.data) : [];
  const response = await fetch(`${CONFIG.EXECUTOR_LLM.HOST}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: CONFIG.EXECUTOR_LLM.MODEL, messages: [{ role: 'user', content: plannerPrompt, images: formattedImages }], think: false, stream: false, options: { temperature: 0.2 } })
  });
  const data = await response.json();
  const rawText = data.message.content.trim();
  try {
     let cleanText = rawText.replace(/```json/i, '').replace(/```/g, '').trim();
     const start = cleanText.indexOf('{'), end = cleanText.lastIndexOf('}');
     if (start !== -1 && end !== -1) cleanText = cleanText.substring(start, end + 1);
     return JSON.parse(cleanText);
  } catch (e) { throw new Error(`Planner returned invalid JSON.`); }
}

async function runExpertStep(skill, messages, authorizedTools, executionId, finalHost, sessionImages, sessionFiles) {
  const currentConfig = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  let promptTokens = 0, completionTokens = 0, capturedImages = [], stepFinalContent = "";
  while (true) {
    currentExpertAbortController = new AbortController();
    const response = await fetch(`${CONFIG.EXECUTOR_LLM.HOST}/api/chat`, {
      method: 'POST', body: JSON.stringify({ model: CONFIG.EXECUTOR_LLM.MODEL, messages, tools: authorizedTools, think: false, stream: true }),
      signal: currentExpertAbortController.signal
    });
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let fullContent = "", toolCalls = [], buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.message?.thinking && currentConfig.EXECUTOR_THINK) relayLog(data.message.thinking, 'thinking_chunk');
          if (data.message?.content) { relayLog(data.message.content, 'console_log_stream'); fullContent += data.message.content; }
          if (data.message?.tool_calls) toolCalls = toolCalls.concat(data.message.tool_calls);
          if (data.done) { promptTokens += (data.prompt_eval_count || 0); completionTokens += (data.eval_count || 0); }
        } catch (e) {}
      }
    }
    const assistantMsg = { role: 'assistant', content: fullContent };
    if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
    messages.push(assistantMsg);
    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        if (call.function.name === 'get_tool_usage') call.function.arguments.execution_id = executionId;
        let toolData;
        const localTool = localTools.find(t => t.name === call.function.name);
        if (localTool) toolData = await localTool.handler(call.function.arguments, sessionImages, sessionFiles);
        else {
          const toolRes = await fetch(`${CONFIG.RESOURCE_MCP_URL}/call`, { 
            method: 'POST', headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ name: call.function.name, arguments: call.function.arguments, execution_id: executionId, clientHost: finalHost }) 
          });
          toolData = await toolRes.json();
        }
        const text = toolData.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        const imgs = toolData.content.filter(c => c.type === 'image').map(c => c.data);
        if (imgs.length > 0) capturedImages = capturedImages.concat(imgs);
        messages.push({ role: 'tool', content: text, tool_call_id: call.id });
        if (imgs.length > 0) messages.push({ role: 'user', content: "Attached captured visuals.", images: imgs });
      }
      continue;
    }
    stepFinalContent = fullContent; break;
  }
  return { messages, content: stepFinalContent, promptTokens, completionTokens, capturedImages };
}

async function runExecuteLoop(planJSON, skill, instructionJSON, images, files, clientHost, currentId) {
  const allAvailableTools = [...resourceTools, ...localTools], finalHost = clientHost || "localhost:3000";
  const authorizedTools = allAvailableTools.filter(t => [...skill.use, "get_tool_usage"].includes(t.name)).map(t => {
    if (t.name === "get_tool_usage") return { type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } };
    return { type: 'function', function: { name: t.name, description: `${t.description} (SCHEMA HIDDEN)`, parameters: { type: "object", properties: {}, additionalProperties: true } } };
  });
  let expertSystemPrompt = fs.readFileSync('exe_system.md', 'utf8').replace('{{skill_system}}', skill.system);
  expertSystemPrompt += `\n\n### CONTEXT\n${cachedEnvInfo}\nGoal: ${planJSON.goal}`;
  let messages = [{ role: 'system', content: expertSystemPrompt }, { role: 'user', content: `Start execution. Plan: ${JSON.stringify(planJSON.plan)}` }];
  if (images && images.length > 0) messages[1].images = images.map(img => typeof img === 'string' ? img : img.data);
  let results = [], totalP = 0, totalC = 0, allImgs = [];
  for (let i = 0; i < planJSON.plan.length; i++) {
    messages.push({ role: 'user', content: `Step ${i+1}: ${planJSON.plan[i]}` });
    const stepRes = await runExpertStep(skill, messages, authorizedTools, currentId, finalHost, images, files);
    messages = stepRes.messages; totalP += stepRes.promptTokens; totalC += stepRes.completionTokens;
    allImgs = allImgs.concat(stepRes.capturedImages);
    results.push({ step: planJSON.plan[i], output: stepRes.content });
  }
  return { results, tokens: { prompt: totalP, completion: totalC }, images: allImgs };
}

async function runReporter(instructionJSON, loopData) {
  const reporterPrompt = `任务: ${JSON.stringify(instructionJSON)}\n结果: ${JSON.stringify(loopData.results)}\n请返回 JSON: {"report": "Markdown总结"}`;
  const response = await fetch(`${CONFIG.EXECUTOR_LLM.HOST}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: CONFIG.EXECUTOR_LLM.MODEL, messages: [{ role: 'user', content: reporterPrompt }], think: false, stream: false, options: { temperature: 0.3 } })
  });
  const data = await response.json();
  try {
     let cleanText = data.message.content.trim().replace(/```json/i, '').replace(/```/g, '').trim();
     return JSON.parse(cleanText);
  } catch (e) { return { report: data.message.content }; }
}

app.post("/call", async (req, res) => {
  executionCounter++;
  const currentId = executionCounter;
  const { arguments: args, clientHost } = req.body;
  
  // 解析符合新协议的请求: { result, message, attachment, data }
  const request = args?.task || {};
  const instruction = request.message || "No instruction";
  const files = request.attachment || [];
  const images = request.data?.images || [];

  relayLog(`[DELEGATE] ${instruction} (ID: ${currentId})`);
  const enabledSkills = getEnabledSkills();

  try {
    const planJSON = await runPlanner({ instruction }, enabledSkills, files, images);
    const bestSkill = enabledSkills.find(s => s.name === planJSON.expert) || enabledSkills[0];
    const loopData = await runExecuteLoop(planJSON, bestSkill, { instruction }, images, files, clientHost, currentId);
    const finalReport = await runReporter({ instruction }, loopData);

    // 返回符合新协议的结果: { result, message, attachment, data }
    res.json({ 
      result: true,
      message: finalReport.report,
      attachment: files, // 保持附件上下文
      data: {
        images: loopData.images || [],
        tokens: loopData.tokens,
        planner: planJSON
      }
    });
  } catch (e) {
    res.status(500).json({ result: false, message: e.message, attachment: [], data: {} });
  }
});

app.get("/list", (req, res) => {
  res.json({ 
    tools: [{ 
      name: "delegate_task", 
      description: "Mandatory for system operations.", 
      inputSchema: { 
        type: "object", 
        properties: { 
          task: { 
            type: "object", 
            description: "Standardized JSON Communication Protocol.",
            properties: {
              result: { type: "boolean", description: "Set to true." },
              message: { type: "string", description: "The core instruction string." },
              attachment: { type: "array", description: "Session files metadata." },
              data: { type: "object", properties: { images: { type: "array" } } }
            },
            required: ["result", "message"]
          } 
        }, 
        required: ["task"] 
      } 
    }] 
  });
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
  res.json({ result: true });
});

async function start() {
  loadSkills(); await syncResourceTools(); await fetchInitialEnvInfo();
  app.listen(CONFIG.EXECUTOR_PORT, "0.0.0.0", () => console.log(`Executor on ${CONFIG.EXECUTOR_PORT}`));
}
start();