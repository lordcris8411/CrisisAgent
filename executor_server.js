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

let skills = [], resourceTools = [], currentExpertAbortController = null, cachedEnvInfo = "System environment info not loaded.", executionCounter = 0;

async function fetchInitialEnvInfo() {
  try {
    const res = await fetch(`${CONFIG.RESOURCE_MCP_URL}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'get_env_info', arguments: {}, execution_id: -1 }) });
    const data = await res.json();
    if (data.content?.[0]) { cachedEnvInfo = data.content[0].text; console.log(`${STYLES.green}[Executor] Env context loaded.${STYLES.reset}`); }
  } catch (e) { console.error(`${STYLES.red}[Executor] Env load failed: ${e.message}${STYLES.reset}`); }
}

const localTools = [
  {
    name: "read_local_file",
    description: "Read local mcp_server file.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    handler: async (args) => ({ content: [{ type: "text", text: fs.readFileSync(path.resolve(__dirname, 'mcp_server', args.path), 'utf8') }] })
  },
  {
    name: "write_local_file",
    description: "Write local file.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    handler: async (args) => {
      const fullPath = path.resolve(args.path); fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      let data = args.content; if (data.startsWith('BASE64_DATA:')) data = Buffer.from(data.replace('BASE64_DATA:', ''), 'base64');
      fs.writeFileSync(fullPath, data); return { content: [{ type: "text", text: `Saved to ${fullPath}` }] };
    }
  },
  {
    name: "save_uploaded_image",
    description: "Save uploaded image.",
    inputSchema: { type: "object", properties: { image_index: { type: "integer" }, local_path: { type: "string" } } },
    handler: async (args, sessionImages) => {
      try {
        let idx = args.image_index; if (idx === undefined && sessionImages?.length === 1) idx = 0;
        if (!sessionImages?.[idx]) throw new Error("Image not found");
        const imgObj = sessionImages[idx]; const base64Data = typeof imgObj === 'string' ? imgObj : imgObj.data;
        const targetPath = path.resolve(args.local_path || `uploads/image_${Date.now()}.jpg`);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true }); fs.writeFileSync(targetPath, Buffer.from(base64Data, 'base64'));
        return { content: [{ type: "text", text: `SUCCESS: Saved to ${targetPath}` }] };
      } catch (e) { return { isError: true, content: [{ type: "text", text: e.message }] }; }
    }
  },
  {
    name: "get_tool_usage",
    description: "Get tool schema.",
    inputSchema: { type: "object", properties: { tool_name: { type: "string" }, execution_id: { type: "integer" } }, required: ["tool_name"] },
    handler: async (args) => {
      const localTarget = localTools.find(t => t.name === args.tool_name); if (localTarget) return { content: [{ type: "text", text: JSON.stringify(localTarget.inputSchema) }] };
      const toolRes = await fetch(`${CONFIG.RESOURCE_MCP_URL}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'get_tool_usage', arguments: { tool_name: args.tool_name }, execution_id: args.execution_id }) });
      return await toolRes.json();
    }
  }
];

function loadSkills() {
  const dir = path.join(__dirname, 'functions'); if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.func'));
  skills = []; for (const f of files) { try { skills.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch(e) {} }
}

async function syncResourceTools() {
  try { const res = await fetch(`${CONFIG.RESOURCE_MCP_URL}/list`); resourceTools = (await res.json()).tools; } catch (e) {}
}

function getEnabledSkills() { return skills.filter(s => s.enabled !== false); }

async function runPlanner(instructionJSON, enabledSkills, files, images) {
  const skillSpecs = enabledSkills.map(s => `- ${s.name}: ${s.description}\n  [Tools]: ${s.use.join(', ')}`).join('\n');
  const plannerPrompt = `Planner Center.\nTask: ${JSON.stringify(instructionJSON)}\nExperts:\n${skillSpecs}\nMust output JSON: {"expert": "...", "goal": "...", "plan": ["..."]}`;
  relayLog(`\n[STAGE 1] Planning mission...`);
  const formattedImages = images ? images.map(img => typeof img === 'string' ? img : img.data) : [];
  const response = await fetch(`${CONFIG.EXECUTOR_LLM.HOST}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: CONFIG.EXECUTOR_LLM.MODEL, messages: [{ role: 'user', content: plannerPrompt, images: formattedImages }], think: false, stream: false, options: { temperature: 0 } })
  });
  const data = await response.json();
  try {
     let cleanText = data.message.content.trim().replace(/```json/i, '').replace(/```/g, '').trim();
     const start = cleanText.indexOf('{'), end = cleanText.lastIndexOf('}');
     if (start !== -1 && end !== -1) cleanText = cleanText.substring(start, end + 1);
     const planJSON = JSON.parse(cleanText);
     relayLog(`[Planner Decision] Expert: ${planJSON.expert}, Steps: ${planJSON.plan.length}`);
     return planJSON;
  } catch (e) { throw new Error(`Planner failed to generate valid JSON.`); }
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
      const { done, value } = await reader.read(); if (done) break;
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
    const assistantMsg = { role: 'assistant', content: fullContent }; if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
    messages.push(assistantMsg);
    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        if (call.function.name === 'get_tool_usage') call.function.arguments.execution_id = executionId;
        
        // 关键：打印工具调用请求到 Web UI
        relayLog(`[Tool Request] ${call.function.name}: ${JSON.stringify(call.function.arguments)}`);
        
        let toolData; const localTool = localTools.find(t => t.name === call.function.name);
        if (localTool) toolData = await localTool.handler(call.function.arguments, sessionImages, sessionFiles);
        else {
          const toolRes = await fetch(`${CONFIG.RESOURCE_MCP_URL}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: call.function.name, arguments: call.function.arguments, execution_id: executionId, clientHost: finalHost }) });
          toolData = await toolRes.json();
        }
        const text = toolData.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        const imgs = toolData.content.filter(c => c.type === 'image').map(c => c.data);
        if (imgs.length > 0) capturedImages = capturedImages.concat(imgs);
        messages.push({ role: 'tool', content: text, tool_call_id: call.id });
        if (imgs.length > 0) messages.push({ role: 'user', content: "Attached captured visuals.", images: imgs });
        
        // 关键：打印工具调用结果到 Web UI
        relayLog(`[Tool Response] ${call.function.name}: ${text.length > 500 ? text.substring(0, 500) + '...' : text}`);
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
  expertSystemPrompt += `\n\n### CONTEXT\n${cachedEnvInfo}\nOverall Goal: ${planJSON.goal}`;
  let messages = [{ role: 'system', content: expertSystemPrompt }, { role: 'user', content: `Start mission loop. Plan: ${JSON.stringify(planJSON.plan)}` }];
  if (images && images.length > 0) messages[1].images = images.map(img => typeof img === 'string' ? img : img.data);
  let results = [], totalP = 0, totalC = 0, allImgs = [];
  relayLog(`\n[STAGE 2] Execute_Loop with expert [${skill.name}]`);
  for (let i = 0; i < planJSON.plan.length; i++) {
    relayLog(`\n[STEP ${i+1}/${planJSON.plan.length}] ${planJSON.plan[i]}`);
    messages.push({ role: 'user', content: `Execute step ${i+1}: ${planJSON.plan[i]}` });
    const stepRes = await runExpertStep(skill, messages, authorizedTools, currentId, finalHost, images, files);
    messages = stepRes.messages; totalP += stepRes.promptTokens; totalC += stepRes.completionTokens;
    allImgs = allImgs.concat(stepRes.capturedImages);
    results.push({ step: planJSON.plan[i], output: stepRes.content });
  }
  return { results, tokens: { prompt: totalP, completion: totalC }, images: allImgs };
}

async function runReporter(instructionJSON, loopData) {
  const reporterPrompt = `Original Task: ${JSON.stringify(instructionJSON)}\nHistory: ${JSON.stringify(loopData.results)}\nSummarize mission in Markdown. Return JSON: {"report": "..."}`;
  relayLog(`\n[STAGE 3] Finalizing report...`);
  const response = await fetch(`${CONFIG.EXECUTOR_LLM.HOST}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: CONFIG.EXECUTOR_LLM.MODEL, messages: [{ role: 'user', content: reporterPrompt }], think: false, stream: false, options: { temperature: 0.2 } })
  });
  const data = await response.json();
  try {
     let cleanText = data.message.content.trim().replace(/```json/i, '').replace(/```/g, '').trim();
     const start = cleanText.indexOf('{'), end = cleanText.lastIndexOf('}');
     if (start !== -1 && end !== -1) cleanText = cleanText.substring(start, end + 1);
     return JSON.parse(cleanText);
  } catch (e) { return { report: data.message.content }; }
}

app.post("/call", async (req, res) => {
  executionCounter++; const currentId = executionCounter;
  const { arguments: args, clientHost } = req.body;
  const request = args?.task || {};
  const instruction = request.message || "No instruction";
  const files = request.attachment || [];
  const images = request.data?.images || [];
  relayLog(`\n${STYLES.bold}>>> MISSION START [ID: ${currentId}]: ${instruction}${STYLES.reset}`);
  const enabledSkills = getEnabledSkills();
  try {
    const planJSON = await runPlanner({ instruction }, enabledSkills, files, images);
    const bestSkill = enabledSkills.find(s => s.name === planJSON.expert) || enabledSkills[0];
    const loopData = await runExecuteLoop(planJSON, bestSkill, { instruction }, images, files, clientHost, currentId);
    const finalReport = await runReporter({ instruction }, loopData);
    relayLog(`\n${STYLES.bold}<<< MISSION COMPLETE [ID: ${currentId}]${STYLES.reset}\n`);
    res.json({ result: true, message: finalReport.report, attachment: files, data: { images: loopData.images || [], tokens: loopData.tokens, planner: planJSON } });
  } catch (e) {
    relayLog(`[ERROR] ${e.message}`);
    res.status(500).json({ result: false, message: e.message, attachment: [], data: {} });
  }
});

app.get("/list", (req, res) => {
  res.json({ tools: [{ name: "delegate_task", description: "Mandatory.", inputSchema: { type: "object", properties: { task: { type: "object", properties: { result: { type: "boolean" }, message: { type: "string" }, attachment: { type: "array" }, data: { type: "object" } }, required: ["result", "message"] } }, required: ["task"] } }] });
});
app.get("/skills", (req, res) => res.json({ skills }));
app.get("/mcp_tools", (req, res) => res.json({ remote: resourceTools, local: localTools }));
app.post("/set_skill_status", (req, res) => {
  const { name, enabled } = req.body; const filePath = path.join(__dirname, 'functions', `${name}.func`);
  try {
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8')); content.enabled = enabled;
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8'); loadSkills(); res.json({ result: true });
  } catch (e) { res.status(500).json({ result: false, message: e.message }); }
});
app.get("/capabilities", (req, res) => { res.json({ summary: `Capabilities:\n${skills.filter(s => s.enabled !== false).map(s => `- ${s.description}`).join('\n')}` }); });
app.get("/system_prompt", (req, res) => { try { res.json({ template: fs.readFileSync('exe_system.md', 'utf8'), env_context: cachedEnvInfo }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/reboot", (req, res) => { res.json({ result: true }); setTimeout(() => process.exit(99), 100); });
app.post("/interrupt", (req, res) => { if (currentExpertAbortController) { currentExpertAbortController.abort(); currentExpertAbortController = null; return res.json({ result: true, message: "Interrupted" }); } res.json({ result: false, message: "No active inference" }); });

async function start() {
  loadSkills(); await syncResourceTools(); await fetchInitialEnvInfo();
  app.listen(CONFIG.EXECUTOR_PORT, "0.0.0.0", () => console.log(`Executor on ${CONFIG.EXECUTOR_PORT}`));
}
start();
