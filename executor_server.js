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
    description: "Save an image uploaded via WebUI/CLI to a local path. If no path provided, saves to 'uploads/'.",
    inputSchema: { 
      type: "object", 
      properties: { 
        image_index: { type: "integer", description: "Index of the image (0-based). Optional if only one image exists." },
        local_path: { type: "string", description: "Target local path (e.g., 'C:/my_images/test.jpg')." }
      }
    },
    handler: async (args, sessionImages) => {
      try {
        let idx = args.image_index;
        if (idx === undefined && sessionImages && sessionImages.length === 1) idx = 0;
        
        if (!sessionImages || idx === undefined || sessionImages[idx] === undefined) {
          throw new Error(`No image found at index ${idx}. Available: ${sessionImages ? sessionImages.length : 0}`);
        }

        const imgObj = sessionImages[idx];
        const base64Data = typeof imgObj === 'string' ? imgObj : imgObj.data;
        const originalName = (typeof imgObj === 'object' && imgObj.name) ? imgObj.name : `upload_${Date.now()}.jpg`;

        let targetPath = args.local_path || args.path || args.destination;
        if (!targetPath) {
          const uploadsDir = path.join(process.cwd(), 'uploads');
          if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
          targetPath = path.join(uploadsDir, originalName);
        } else if (targetPath.endsWith('/') || targetPath.endsWith('\\') || !path.extname(targetPath)) {
          fs.mkdirSync(targetPath, { recursive: true });
          targetPath = path.join(targetPath, originalName);
        } else {
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        }
        
        const buffer = Buffer.from(base64Data, 'base64');
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
        file_index: { type: "integer", description: "Index of the file (0-based). Optional if only one file exists." },
        local_path: { type: "string", description: "Target local path (e.g., 'D:/data/info.pdf')." }
      }
    },
    handler: async (args, sessionImages, sessionFiles) => {
      try {
        let idx = args.file_index;
        if (idx === undefined && sessionFiles && sessionFiles.length === 1) idx = 0;

        if (!sessionFiles || idx === undefined || !sessionFiles[idx]) {
          throw new Error(`No file found at index ${idx}. Available: ${sessionFiles ? sessionFiles.length : 0}`);
        }
        
        const file = sessionFiles[idx];
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
    name: "get_tool_usage",
    description: "Retrieve the full JSON Schema (parameters) for a specific tool. Mandatory before using any 'SCHEMA HIDDEN' tools.",
    inputSchema: { 
      type: "object", 
      properties: { 
        tool_name: { type: "string", description: "The name of the tool to research." },
        execution_id: { type: "integer", description: "Internal context ID." }
      }, 
      required: ["tool_name"] 
    },
    handler: async (args) => {
      const localTarget = localTools.find(t => t.name === args.tool_name);
      if (localTarget) {
        return { content: [{ type: "text", text: `Tool: ${localTarget.name}\nDescription: ${localTarget.description}\nSchema: ${JSON.stringify(localTarget.inputSchema, null, 2)}` }] };
      }

      try {
        const toolRes = await fetch(`${CONFIG.RESOURCE_MCP_URL}/call`, { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ 
            name: 'get_tool_usage', 
            arguments: { tool_name: args.tool_name },
            execution_id: args.execution_id 
          }) 
        });
        return await toolRes.json();
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `Remote Discovery Error: ${e.message}` }] };
      }
    }
  }
];

function loadSkills() {
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

async function syncResourceTools() {
  try {
    const res = await fetch(`${CONFIG.RESOURCE_MCP_URL}/list`);
    const data = await res.json();
    resourceTools = data.tools;
    const msg = `Synced ${resourceTools.length} tools.`;
    console.log(`${STYLES.green}${msg}${STYLES.reset}`);
    relayLog(msg);
  } catch (e) { console.error(`Resource MCP Error: ${e.message}`); }
}

function getEnabledSkills() { return skills.filter(s => s.enabled !== false); }

// ============================================================================
// STAGE 1: PLANNER
// ============================================================================
async function runPlanner(instructionJSON, enabledSkills, files, images) {
  let contextHint = "";
  if (files && files.length > 0) contextHint += `\n[Context: ${files.length} file(s) attached to session]`;
  if (images && images.length > 0) contextHint += `\n[Context: ${images.length} image(s) attached to session]`;

  const skillSpecs = enabledSkills.map(s => `- ${s.name}: ${s.description}`).join('\n');
  const plannerPrompt = `Task JSON: ${JSON.stringify(instructionJSON)}${contextHint}\n\n作为 Planner (规划者)，你必须强制执行【链式思维】。请根据任务目标，从以下列表中选择最合适的专家技能 (Expert)，并将任务拆解为具体的执行步骤 (Plan)。\n\n可用技能:\n${skillSpecs}\n\n你必须且只能返回一个合法的 JSON 对象，不要包含任何 markdown 代码块标记，结构如下：\n{\n  "expert": "<skill_name 或者是 NONE>",\n  "goal": "<总体目标的简短描述>",\n  "plan": [\n    "<第一步要执行的操作>",\n    "<第二步要执行的操作>"\n  ]\n}`;

  const formattedImages = images ? images.map(img => typeof img === 'string' ? img : img.data) : [];

  const response = await fetch(`${CONFIG.EXECUTOR_LLM.HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      model: CONFIG.EXECUTOR_LLM.MODEL, 
      messages: [{ role: 'user', content: plannerPrompt, images: formattedImages }], 
      think: false, 
      stream: false, 
      options: { temperature: 0.2 }
    })
  });
  
  const data = await response.json();
  const rawText = data.message.content.trim();
  
  try {
     let cleanText = rawText.replace(/```json/i, '').replace(/```/g, '').trim();
     const start = cleanText.indexOf('{');
     const end = cleanText.lastIndexOf('}');
     if (start !== -1 && end !== -1) cleanText = cleanText.substring(start, end + 1);
     return JSON.parse(cleanText);
  } catch (e) {
     console.error("Planner parsing failed:", rawText);
     throw new Error(`Planner returned invalid JSON.`);
  }
}

// ============================================================================
// STAGE 2: EXECUTE LOOP
// ============================================================================
async function runExpertStep(skill, messages, authorizedTools, executionId, finalHost, sessionImages, sessionFiles) {
  const currentConfig = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  let promptTokens = 0;
  let completionTokens = 0;
  let capturedImages = [];
  let stepFinalContent = "";

  while (true) {
    currentExpertAbortController = new AbortController();
    const response = await fetch(`${CONFIG.EXECUTOR_LLM.HOST}/api/chat`, {
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

    while (true) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) {
            try {
              const data = JSON.parse(buffer);
              const message = data.message;
              if (message?.thinking && currentConfig.EXECUTOR_THINK) relayLog(message.thinking, 'thinking_chunk');
              if (message?.content) { relayLog(message.content, 'console_log_stream'); fullContent += message.content; }
              if (data.message?.tool_calls) toolCalls = toolCalls.concat(data.message.tool_calls);
            } catch (e) {}
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            const message = data.message;
            if (message?.thinking && currentConfig.EXECUTOR_THINK) relayLog(message.thinking, 'thinking_chunk');
            if (message?.content) { relayLog(message.content, 'console_log_stream'); fullContent += message.content; }
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

    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        if (call.function.name === 'get_tool_usage') call.function.arguments.execution_id = executionId;
        const argsString = JSON.stringify(call.function.arguments);
        const toolLog = `[Execute_Loop -> Expert] Tool Call: ${call.function.name} (${argsString})`;
        console.log(`${STYLES.dim}${toolLog}${STYLES.reset}`);
        relayLog(toolLog);

        let toolData;
        const localTool = localTools.find(t => t.name === call.function.name);
        if (localTool) toolData = await localTool.handler(call.function.arguments, sessionImages, sessionFiles);
        else {
          const toolRes = await fetch(`${CONFIG.RESOURCE_MCP_URL}/call`, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ name: call.function.name, arguments: call.function.arguments, execution_id: executionId, clientHost: finalHost }) 
          });
          toolData = await toolRes.json();
        }

        const text = toolData.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        const capturedImagesFromTool = toolData.content.filter(c => c.type === 'image').map(c => c.data);
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
    stepFinalContent = fullContent;
    break;
  }
  return { messages, content: stepFinalContent, promptTokens, completionTokens, capturedImages };
}

async function runExecuteLoop(planJSON, skill, instructionJSON, images, files, clientHost, currentId) {
  const allAvailableTools = [...resourceTools, ...localTools];
  const finalHost = clientHost || "localhost:3000";
  const authorizedNames = [...skill.use, "get_tool_usage"];
  const authorizedToolsRaw = allAvailableTools.filter(t => authorizedNames.includes(t.name));
  
  const authorizedTools = authorizedToolsRaw.map(t => {
    if (t.name === "get_tool_usage") return { type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } };
    return { 
      type: 'function', 
      function: { name: t.name, description: `${t.description} (SCHEMA HIDDEN: Call 'get_tool_usage' to unlock parameters)`, parameters: { type: "object", properties: {}, additionalProperties: true } } 
    };
  });

  let expertSystemPrompt = "";
  try {
    const template = fs.readFileSync('exe_system.md', 'utf8');
    expertSystemPrompt = template.replace('{{skill_system}}', skill.system);
    expertSystemPrompt += `\n\n### CURRENT SYSTEM ENVIRONMENT CONTEXT\n${cachedEnvInfo}`;
    expertSystemPrompt += `\n\n### OVERALL GOAL\n${planJSON.goal}`;
    expertSystemPrompt += `\n\n[EXECUTION PROTOCOL] You are running within an Execute_Loop. You will receive one step at a time from the overall plan. Focus ONLY on completing the current step using available tools, then return a text summary of what you did.`;
  } catch (e) {
    expertSystemPrompt = `${skill.system}\n\n### CURRENT SYSTEM ENVIRONMENT CONTEXT\n${cachedEnvInfo}`;
  }

  let messages = [
    { role: 'system', content: expertSystemPrompt },
    { role: 'user', content: `总体任务 JSON: ${JSON.stringify(instructionJSON)}\n现在我们将开始按计划逐条执行。` }
  ];

  if (images && images.length > 0) messages[1].images = images.map(img => typeof img === 'string' ? img : img.data);

  let executionResults = [];
  let totalPrompt = 0;
  let totalCompletion = 0;
  let allCapturedImages = [];

  for (let i = 0; i < planJSON.plan.length; i++) {
    const step = planJSON.plan[i];
    const stepLog = `\n[Execute_Loop] Processing Step ${i+1}/${planJSON.plan.length}: ${step}`;
    console.log(`${STYLES.cyan}${stepLog}${STYLES.reset}`);
    relayLog(stepLog);
    messages.push({ role: 'user', content: `[Execute_Loop] 请执行计划的第 ${i+1} 步: ${step}` });
    const stepRes = await runExpertStep(skill, messages, authorizedTools, currentId, finalHost, images, files);
    messages = stepRes.messages;
    totalPrompt += stepRes.promptTokens;
    totalCompletion += stepRes.completionTokens;
    allCapturedImages = allCapturedImages.concat(stepRes.capturedImages);
    executionResults.push({ step: step, output: stepRes.content });
  }

  return { results: executionResults, tokens: { prompt: totalPrompt, completion: totalCompletion }, images: allCapturedImages };
}

// ============================================================================
// STAGE 3: REPORTER
// ============================================================================
async function runReporter(instructionJSON, loopData) {
  const reporterPrompt = `原始任务 JSON: ${JSON.stringify(instructionJSON)}\n\n【Execute_Loop 执行结果 (JSON)】\n${JSON.stringify(loopData.results, null, 2)}\n\n作为 Reporter (汇报者)，你的任务是综合这些步骤的执行结果，向用户汇报最终总结。你必须且只能返回一个合法的 JSON 对象，不要包含 markdown 代码块标记，结构如下：\n{\n  "report": "<向用户汇报的最终 Markdown 格式文本总结>"\n}`;

  const response = await fetch(`${CONFIG.EXECUTOR_LLM.HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: CONFIG.EXECUTOR_LLM.MODEL, messages: [{ role: 'user', content: reporterPrompt }], think: false, stream: false, options: { temperature: 0.3 } })
  });

  const data = await response.json();
  const rawText = data.message.content.trim();
  
  try {
     let cleanText = rawText.replace(/```json/i, '').replace(/```/g, '').trim();
     const start = cleanText.indexOf('{');
     const end = cleanText.lastIndexOf('}');
     if (start !== -1 && end !== -1) cleanText = cleanText.substring(start, end + 1);
     return JSON.parse(cleanText);
  } catch (e) {
     return { report: rawText };
  }
}

// ============================================================================
// MAIN ROUTES
// ============================================================================
app.post("/call", async (req, res) => {
  executionCounter++;
  const currentId = executionCounter;
  const { arguments: args, skill_name, images, files, clientHost } = req.body;
  
  // 核心：处理 JSON 格式的指令
  let instructionJSON = args?.task;
  if (typeof instructionJSON === 'string') {
    try { instructionJSON = JSON.parse(instructionJSON); } catch (e) { instructionJSON = { instruction: instructionJSON }; }
  }

  const delegateLog = `[DELEGATE] Task: ${instructionJSON.instruction || JSON.stringify(instructionJSON)} (ID: ${currentId})`;
  console.log(`${STYLES.bold}${delegateLog}${STYLES.reset}`);
  relayLog(delegateLog);
  
  const enabledSkills = getEnabledSkills();

  try {
    let planJSON;
    if (skill_name) {
      planJSON = { expert: skill_name, goal: instructionJSON.instruction || skill_name, plan: [`Execute requested task`] };
    } else {
      planJSON = await runPlanner(instructionJSON, enabledSkills, files, images);
      relayLog(`[Planner] Expert: ${planJSON.expert}\n[Plan]\n${planJSON.plan.map((p,i)=>`${i+1}. ${p}`).join('\n')}`);
    }

    if (!planJSON.expert || planJSON.expert.toUpperCase() === "NONE" || !enabledSkills.find(s => s.name === planJSON.expert)) {
      return res.json({ status: "error", message: "No suitable skill found", planner_output: planJSON });
    }

    const bestSkill = enabledSkills.find(s => s.name === planJSON.expert);
    const loopData = await runExecuteLoop(planJSON, bestSkill, instructionJSON, images, files, clientHost, currentId);
    const finalReport = await runReporter(instructionJSON, loopData);

    res.json({ 
      status: "success",
      report: finalReport.report, 
      tokens: { prompt: loopData.tokens.prompt, completion: loopData.tokens.completion }, 
      images: loopData.images || [] 
    });
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
    relayLog(`Error: ${e.message}`);
    res.status(500).json({ status: "error", message: e.message });
  }
});

app.get("/list", (req, res) => {
  res.json({ 
    tools: [{ 
      name: "delegate_task", 
      description: "Mandatory tool for all system-level operations. Use this for file search, I/O, process management, vision, or hardware/env info.", 
      inputSchema: { 
        type: "object", 
        properties: { 
          task: { 
            type: "object", 
            description: "Structured instruction object.",
            properties: {
              instruction: { type: "string", description: "The core command." },
              context: { type: "string", description: "Optional context." }
            },
            required: ["instruction"]
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
  res.json({ status: "success" });
});

async function start() {
  loadSkills();
  await syncResourceTools();
  await fetchInitialEnvInfo();
  app.listen(CONFIG.EXECUTOR_PORT, "0.0.0.0", () => {
    console.log(`Executor ready on ${CONFIG.EXECUTOR_PORT}`);
  });
}
start();