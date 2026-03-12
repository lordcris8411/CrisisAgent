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

// ============================================================================
// UTILITIES & STATE
// ============================================================================
function safeParseJSON(raw) {
  if (!raw) return null;
  let clean = raw.trim();
  clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(clean); } catch (e) {
    const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
    if (start !== -1 && end !== -1) { try { return JSON.parse(clean.substring(start, end + 1)); } catch (e2) { return null; } }
    return null;
  }
}

async function fetchWithTimeout(url, options = {}, timeout = 60000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id); return response;
  } catch (e) { clearTimeout(id); throw e; }
}

function relayLog(content, type = 'console_log') {
  const cleanText = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  const finalContent = cleanText.replace(/\x1b\[[0-9;]*m/g, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);
  fetch(`http://localhost:3002/api/log`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: finalContent, type }),
    signal: controller.signal
  }).catch(() => {}).finally(() => clearTimeout(timeout));
}

let skills = [], resourceTools = [], currentExpertAbortController = null, cachedEnvInfo = "System context not loaded.", executionCounter = 0;

const localTools = [
  { 
    name: "read_local_file", description: "Read local mcp_server file.", 
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, 
    handler: async (args) => ({ content: [{ type: "text", text: fs.readFileSync(path.resolve(__dirname, 'mcp_server', args.path), 'utf8') }] }) 
  },
  { 
    name: "write_local_file", description: "Write local file.", 
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }, 
    handler: async (args) => { 
      const fullPath = path.resolve(args.path); fs.mkdirSync(path.dirname(fullPath), { recursive: true }); 
      let data = args.content; if (data.startsWith('BASE64_DATA:')) data = Buffer.from(data.replace('BASE64_DATA:', ''), 'base64'); 
      fs.writeFileSync(fullPath, data); return { content: [{ type: "text", text: `Saved to ${fullPath}` }] }; 
    } 
  },
  { 
    name: "save_uploaded_image", description: "Save uploaded image.", 
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
    name: "get_tool_usage", description: "Get tool schema.", 
    inputSchema: { type: "object", properties: { tool_name: { type: "string" }, execution_id: { type: "integer" } }, required: ["tool_name"] }, 
    handler: async (args) => { 
      const localTarget = localTools.find(t => t.name === args.tool_name); 
      if (localTarget) return { content: [{ type: "text", text: JSON.stringify(localTarget.inputSchema) }] }; 
      const toolRes = await fetchWithTimeout(`${CONFIG.RESOURCE_MCP_URL}/call`, { 
        method: 'POST', headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ name: 'get_tool_usage', arguments: { tool_name: args.tool_name }, execution_id: args.execution_id }) 
      }, 10000); return await toolRes.json(); 
    } 
  }
];

function getEnabledSkills() { return skills.filter(s => s.enabled !== false); }

// ============================================================================
// CORE STAGES
// ============================================================================

async function runPlanner(instruction, enabledSkills, files, images) {
  const skillSpecs = enabledSkills.map(s => `- Expert: "${s.name}"\n  Tools: [${s.use.join(', ')}]\n  Capabilities: ${s.description}`).join('\n');
  const plannerPrompt = `### MISSION PLANNER PROTOCOL
You are the strategist. Decompose the User Task into logical steps.

### INPUT
Task: "${instruction}"
Files: ${JSON.stringify(files || [])}
Images: ${images ? images.length : 0} attached.

### AVAILABLE EXPERTS & TOOLS
${skillSpecs}

### PLANNING RULES
1. **Logical Order**: Capture tools (e.g. screen_reader) MUST come before analysis tools (e.g. visual_analyst).
2. **Precision**: Choose the Expert whose tools match the action.
3. **Format**: Return ONLY JSON: {"goal": "...", "plan": [{"expert": "...", "step": "..."}]}`;

  relayLog(`\n[STAGE 1] PLANNING MISSION...`);
  try {
    const response = await fetchWithTimeout(`${CONFIG.EXECUTOR_LLM.HOST}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: CONFIG.EXECUTOR_LLM.MODEL, messages: [{ role: 'user', content: plannerPrompt }], think: false, stream: false, format: 'json', options: { temperature: 0 } })
    }, 60000);
    const data = await response.json();
    const planJSON = safeParseJSON(data.message.content);
    if (!planJSON || !planJSON.plan) throw new Error("Planner failed.");
    relayLog({ "[Planner Result]": planJSON });
    return planJSON;
  } catch (e) { relayLog({ "[PLANNER FATAL]": e.message }); throw e; }
}

async function runExpertStep(skill, messages, authorizedTools, executionId, finalHost, sessionImages, sessionFiles) {
  const currentConfig = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  let promptTokens = 0, completionTokens = 0, capturedImages = [], stepFinalContent = "", resources = [];
  while (true) {
    currentExpertAbortController = new AbortController();
    const response = await fetchWithTimeout(`${CONFIG.EXECUTOR_LLM.HOST}/api/chat`, {
      method: 'POST', body: JSON.stringify({ model: CONFIG.EXECUTOR_LLM.MODEL, messages, tools: authorizedTools, think: false, stream: true }),
      signal: currentExpertAbortController.signal
    }, 120000);
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
        relayLog({ "[Expert Request]": { tool: call.function.name, args: call.function.arguments } });
        let toolData; const localTool = localTools.find(t => t.name === call.function.name);
        try {
          if (localTool) toolData = await localTool.handler(call.function.arguments, sessionImages, sessionFiles);
          else {
            const toolRes = await fetchWithTimeout(`${CONFIG.RESOURCE_MCP_URL}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: call.function.name, arguments: call.function.arguments, execution_id: executionId, clientHost: finalHost }) }, 30000);
            toolData = await toolRes.json();
          }
          const text = toolData.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
          const imgs = toolData.content.filter(c => c.type === 'image').map(c => c.data);
          const toolResources = toolData.content.filter(c => c.type === 'resource').map(c => c.metadata);
          if (toolResources.length > 0) resources = resources.concat(toolResources);
          if (imgs.length > 0) capturedImages = capturedImages.concat(imgs);
          messages.push({ role: 'tool', content: text, tool_call_id: call.id });
          if (imgs.length > 0) messages.push({ role: 'user', content: "Attached captured visuals.", images: imgs });
          relayLog({ "[Tool Response]": { tool: call.function.name, resources: toolResources } });
        } catch (te) { relayLog({ "[Tool ERROR]": te.message }); messages.push({ role: 'tool', content: `Error: ${te.message}`, tool_call_id: call.id }); }
      }
      continue;
    }
    stepFinalContent = fullContent; break;
  }
  return { messages, content: stepFinalContent, promptTokens, completionTokens, capturedImages, resources };
}

async function runExecuteLoop(planJSON, enabledSkills, instruction, images, files, clientHost, currentId) {
  const allAvailableTools = [...resourceTools, ...localTools], finalHost = clientHost || "localhost:3000";
  let expertTemplate = fs.readFileSync('exe_system.md', 'utf8');
  let messages = [{ role: 'system', content: `Env: ${cachedEnvInfo}` }, { role: 'user', content: `Start mission: ${instruction}` }];
  if (images && images.length > 0) messages[1].images = images.map(img => typeof img === 'string' ? img : img.data);
  let results = [], totalP = 0, totalC = 0, allImgs = [], allRes = [];
  relayLog(`\n[STAGE 2] COMMENCING EXECUTION LOOP...`);
  for (let i = 0; i < planJSON.plan.length; i++) {
    const ps = planJSON.plan[i];
    const skill = enabledSkills.find(s => s.name === ps.expert) || enabledSkills[0];
    relayLog(`\n[STEP ${i+1}/${planJSON.plan.length}] EXPERT: [${skill.name}] | ACTION: ${ps.step}`);
    const authorizedTools = allAvailableTools.filter(t => [...skill.use, "get_tool_usage"].includes(t.name)).map(t => {
      if (t.name === "get_tool_usage") return { type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } };
      return { type: 'function', function: { name: t.name, description: `${t.description} (SCHEMA HIDDEN)`, parameters: { type: "object", properties: {}, additionalProperties: true } } };
    });
    messages[0].content = expertTemplate.replace('{{skill_system}}', skill.system) + `\n\n### CONTEXT\nEnv: ${cachedEnvInfo}\nGoal: ${planJSON.goal}\n[STEP ${i+1}/${planJSON.plan.length}]: ${ps.step}`;
    messages.push({ role: 'user', content: `Current task: ${ps.step}` });
    try {
      const stepRes = await runExpertStep(skill, messages, authorizedTools, currentId, finalHost, images, files);
      messages = stepRes.messages; totalP += stepRes.promptTokens; totalC += stepRes.completionTokens;
      allImgs = allImgs.concat(stepRes.capturedImages); allRes = allRes.concat(stepRes.resources || []);
      results.push({ expert: skill.name, step: ps.step, output: stepRes.content });
    } catch (e) { relayLog({ "[STEP FAILURE]": e.message }); throw e; }
  }
  return { results, tokens: { prompt: totalP, completion: totalC }, images: allImgs, resources: allRes };
}

async function runReporter(instruction, loopData) {
  const reporterPrompt = `Synthesize results into Markdown report. Task: "${instruction}"\nTrace: ${JSON.stringify(loopData.results)}\nReturn JSON: {"result": true, "message": "Markdown text", "attachment": []}`;
  relayLog("\n[STAGE 3] COMPILING REPORT...");
  try {
    const response = await fetchWithTimeout(`${CONFIG.EXECUTOR_LLM.HOST}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: CONFIG.EXECUTOR_LLM.MODEL, messages: [{ role: 'user', content: reporterPrompt }], think: false, stream: false, format: 'json', options: { temperature: 0.2 } })
    }, 60000);
    const data = await response.json();
    const parsed = safeParseJSON(data.message.content);
    const report = { result: !!parsed, message: parsed ? parsed.message : data.message.content, attachment: (parsed && parsed.attachment) ? parsed.attachment : loopData.resources };
    relayLog({ "[Reporter Result]": report });
    return report;
  } catch (e) { return { result: false, message: "Report failed.", attachment: loopData.resources }; }
}

// ============================================================================
// ROUTES
// ============================================================================
app.post("/call", async (req, res) => {
  executionCounter++; const currentId = executionCounter;
  const { arguments: args, clientHost } = req.body;
  const request = args?.task || {};
  const instruction = request.message || "No instruction";
  relayLog(`\n${STYLES.bold}>>> MISSION ${currentId} START: ${instruction}${STYLES.reset}`);
  const enabledSkills = getEnabledSkills();
  try {
    const planJSON = await runPlanner(instruction, enabledSkills, request.attachment, request.data?.images);
    const loopData = await runExecuteLoop(planJSON, enabledSkills, instruction, request.data?.images, request.attachment, clientHost, currentId);
    const finalReport = await runReporter(instruction, loopData);
    relayLog(`\n${STYLES.bold}<<< MISSION ${currentId} COMPLETE${STYLES.reset}\n`);
    res.json({ result: finalReport.result, message: finalReport.message, attachment: finalReport.attachment, data: { images: loopData.images || [], tokens: loopData.tokens, planner: planJSON } });
  } catch (e) { relayLog({ "[FATAL]": e.message }); res.status(500).json({ result: false, message: `Failure: ${e.message}`, attachment: [], data: {} }); }
});

app.get("/list", (req, res) => { res.json({ tools: [{ name: "delegate_task", description: "Mandatory.", inputSchema: { type: "object", properties: { task: { type: "object", properties: { result: { type: "boolean" }, message: { type: "string" }, attachment: { type: "array" }, data: { type: "object" } }, required: ["result", "message"] } }, required: ["task"] } }] }); });
app.get("/skills", (req, res) => res.json({ skills }));
app.get("/mcp_tools", (req, res) => res.json({ remote: resourceTools, local: localTools }));
app.post("/set_skill_status", (req, res) => {
  const { name, enabled } = req.body; const filePath = path.join(__dirname, 'functions', `${name}.func`);
  try { const content = JSON.parse(fs.readFileSync(filePath, 'utf8')); content.enabled = enabled; fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8'); loadSkills(); res.json({ result: true }); } catch (e) { res.status(500).json({ result: false, message: e.message }); }
});
app.get("/capabilities", (req, res) => { res.json({ summary: `Capabilities:\n${getEnabledSkills().map(s => `- ${s.description}`).join('\n')}` }); });
app.get("/system_prompt", (req, res) => { try { res.json({ template: fs.readFileSync('exe_system.md', 'utf8'), env_context: cachedEnvInfo }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/reboot", (req, res) => { res.json({ result: true }); setTimeout(() => process.exit(99), 100); });
app.post("/interrupt", (req, res) => { if (currentExpertAbortController) { currentExpertAbortController.abort(); currentExpertAbortController = null; return res.json({ result: true, message: "Interrupted" }); } res.json({ result: false, message: "No active inference" }); });

async function fetchInitialEnvInfo() { try { const res = await fetchWithTimeout(`${CONFIG.RESOURCE_MCP_URL}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'get_env_info', arguments: {}, execution_id: -1 }) }, 10000); const data = await res.json(); if (data.content?.[0]) cachedEnvInfo = data.content[0].text; } catch (e) {} }
function loadSkills() { const dir = path.join(__dirname, 'functions'); if (!fs.existsSync(dir)) return; const files = fs.readdirSync(dir).filter(f => f.endsWith('.func')); skills = []; for (const f of files) { try { skills.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch(e) {} } }
async function syncResourceTools() { try { const res = await fetchWithTimeout(`${CONFIG.RESOURCE_MCP_URL}/list`, {}, 5000); resourceTools = (await res.json()).tools; } catch (e) {} }

async function start() { loadSkills(); await syncResourceTools(); await fetchInitialEnvInfo(); app.listen(CONFIG.EXECUTOR_PORT, "0.0.0.0", () => console.log(`Executor on ${CONFIG.EXECUTOR_PORT}`)); }
start();
