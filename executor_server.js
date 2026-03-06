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
    name: "pull_remote_file",
    description: "Pull a file from the remote machine and save it to the local './remote_file/' directory automatically.",
    inputSchema: { 
      type: "object", 
      properties: { 
        remote_path: { type: "string", description: "Path of the file on the remote machine." },
        local_filename: { type: "string", description: "Optional: Name to save as in the local remote_file folder. Defaults to remote filename." }
      }, 
      required: ["remote_path"] 
    },
    handler: async (args) => {
      try {
        const downloadUrl = `${CONFIG.RESOURCE_MCP_URL}/download?path=${encodeURIComponent(args.remote_path)}`;
        const localDir = path.join(process.cwd(), 'remote_file');
        const filename = args.local_filename || path.basename(args.remote_path);
        const fullPath = path.join(localDir, filename);

        if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
        
        const response = await fetch(downloadUrl, {
          headers: { 'X-Auth-Token': CONFIG.AUTH_TOKEN }
        });
        if (!response.ok) throw new Error(`Remote returned ${response.status}: ${await response.text()}`);

        const totalSize = parseInt(response.headers.get('content-length'), 10) || 0;
        let downloaded = 0;
        let lastLoggedPercent = -1;

        const writer = fs.createWriteStream(fullPath);
        const reader = response.body.getReader();

        const startLog = `[Native Pull] Starting stream download: ${filename} (${(totalSize / 1024 / 1024).toFixed(2)} MB)`;
        console.log(`${STYLES.cyan}${startLog}${STYLES.reset}`);
        relayLog(startLog);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          writer.write(value);
          downloaded += value.length;

          if (totalSize > 0) {
            const percent = Math.floor((downloaded / totalSize) * 100);
            if (percent % 10 === 0 && percent !== lastLoggedPercent) {
              const progressLog = `[Progress] Pulling ${filename}: ${percent}% (${(downloaded / 1024 / 1024).toFixed(2)} MB)`;
              console.log(`${STYLES.dim}${progressLog}${STYLES.reset}`);
              relayLog(progressLog);
              lastLoggedPercent = percent;
            }
          }
        }

        writer.end();
        const successLog = `[SUCCESS] File pulled to ${fullPath}`;
        console.log(`${STYLES.green}${successLog}${STYLES.reset}`);
        relayLog(successLog);

        return { content: [{ type: "text", text: successLog }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `Pull failed: ${e.message}` }] };
      }
    }
  },
  {
    name: "push_local_file",
    description: "Push a file from the local machine to the remote machine's specified path.",
    inputSchema: { 
      type: "object", 
      properties: { 
        local_path: { type: "string", description: "Path of the file on the local machine." },
        remote_path: { type: "string", description: "Target path on the remote machine." }
      }, 
      required: ["local_path", "remote_path"] 
    },
    handler: async (args) => {
      try {
        if (!fs.existsSync(args.local_path)) throw new Error(`Local file not found: ${args.local_path}`);
        
        const stats = fs.statSync(args.local_path);
        const totalSize = stats.size;
        const uploadUrl = `${CONFIG.RESOURCE_MCP_URL}/upload?path=${encodeURIComponent(args.remote_path)}`;

        const startLog = `[Native Push] Starting stream upload: ${path.basename(args.local_path)} (${(totalSize / 1024 / 1024).toFixed(2)} MB)`;
        console.log(`${STYLES.cyan}${startLog}${STYLES.reset}`);
        relayLog(startLog);

        let uploaded = 0;
        let lastLoggedPercent = -1;

        const stream = fs.createReadStream(args.local_path);
        
        // 我们利用一个变换流来计算进度
        const { Transform } = require('stream');
        const progressStream = new Transform({
          transform(chunk, encoding, callback) {
            uploaded += chunk.length;
            const percent = Math.floor((uploaded / totalSize) * 100);
            if (percent % 10 === 0 && percent !== lastLoggedPercent) {
              const progressLog = `[Progress] Pushing ${path.basename(args.local_path)}: ${percent}% (${(uploaded / 1024 / 1024).toFixed(2)} MB)`;
              console.log(`${STYLES.dim}${progressLog}${STYLES.reset}`);
              relayLog(progressLog);
              lastLoggedPercent = percent;
            }
            callback(null, chunk);
          }
        });

        const response = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'X-Auth-Token': CONFIG.AUTH_TOKEN },
          body: stream.pipe(progressStream),
          duplex: 'half' // 必须显式设置
        });

        if (!response.ok) throw new Error(await response.text());

        const successLog = `[SUCCESS] File pushed to ${args.remote_path}`;
        console.log(`${STYLES.green}${successLog}${STYLES.reset}`);
        relayLog(successLog);

        return { content: [{ type: "text", text: successLog }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `Push failed: ${e.message}` }] };
      }
    }
  },
  {
    name: "save_uploaded_image",
    description: "Save an image uploaded via WebUI/CLI to the local 'uploads/' directory. Returns the local path.",
    inputSchema: { 
      type: "object", 
      properties: { 
        image_index: { type: "integer", description: "Index of the image in the current message (0 for the first/only image)." },
        filename: { type: "string", description: "Name to save the file as (e.g., 'user_upload.jpg')." }
      }, 
      required: ["image_index", "filename"] 
    },
    handler: async (args, sessionImages) => {
      try {
        relayLog(`[DEBUG] save_uploaded_image called with: ${JSON.stringify(args)}`);
        
        if (args.image_index === undefined && sessionImages && sessionImages.length === 1) {
          args.image_index = 0;
          relayLog(`[DEBUG] Defaulting image_index to 0`);
        }

        if (!sessionImages || sessionImages[args.image_index] === undefined) {
          throw new Error(`No image found at index ${args.image_index}.`);
        }

        const targetName = args.filename || `upload_${Date.now()}.jpg`;
        const uploadsDir = path.join(process.cwd(), 'uploads');
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
        
        const fullPath = path.join(uploadsDir, targetName);
        const buffer = Buffer.from(sessionImages[args.image_index], 'base64');
        fs.writeFileSync(fullPath, buffer);
        
        return { content: [{ type: "text", text: `SUCCESS: Image saved to local uploads/ folder: ${targetName}` }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `Save failed: ${e.message}` }] };
      }
    }
  },
  {
    name: "push_uploaded_file",
    description: "Push a file uploaded in the current session directly to the remote server without saving it locally.",
    inputSchema: { 
      type: "object", 
      properties: { 
        file_index: { type: "integer", description: "Index of the file in session (0 for the first/only file)." },
        remote_path: { type: "string", description: "Full target path on the remote machine (e.g., 'D:/uploads/data.pdf')." }
      }, 
      required: ["file_index", "remote_path"] 
    },
    handler: async (args, sessionImages, sessionFiles) => {
      try {
        relayLog(`[DEBUG] push_uploaded_file called with: ${JSON.stringify(args)}`);
        
        // Fallback for missing index if only one file exists
        if (args.file_index === undefined && sessionFiles && sessionFiles.length === 1) {
          args.file_index = 0;
          relayLog(`[DEBUG] Defaulting file_index to 0`);
        }

        if (!sessionFiles || sessionFiles[args.file_index] === undefined) throw new Error(`No file found at index ${args.file_index}.`);
        const file = sessionFiles[args.file_index];

        // --- Logic Enhancement for remote_path ---
        // Catch common hallucinations: destination, path, target
        let targetPath = args.remote_path || args.destination || args.path || args.target;
        
        if (!targetPath || targetPath === "undefined") {
          // If no path, default to ./uploads/ + original name
          targetPath = `./uploads/${file.name}`;
          relayLog(`[DEBUG] No remote_path provided, defaulting to ${targetPath}`);
        } else if (targetPath.endsWith('/') || targetPath.endsWith('\\')) {
          // If it's a directory, append original filename
          targetPath = path.join(targetPath, file.name).replace(/\\/g, '/');
          relayLog(`[DEBUG] Directory provided, resolved to ${targetPath}`);
        }
        // ----------------------------------------

        const buffer = Buffer.from(file.data, 'base64');
        const uploadUrl = `${CONFIG.RESOURCE_MCP_URL}/upload?path=${encodeURIComponent(targetPath)}`;

        const response = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'X-Auth-Token': CONFIG.AUTH_TOKEN },
          body: buffer,
          duplex: 'half'
        });

        if (!response.ok) throw new Error(await response.text());
        return { content: [{ type: "text", text: `SUCCESS: Session file '${file.name}' pushed directly to remote ${targetPath}` }] };
      } catch (e) { return { isError: true, content: [{ type: "text", text: e.message }] }; }
    }
  },
  {
    name: "push_uploaded_image",
    description: "Push an image uploaded in the current session directly to the remote server.",
    inputSchema: { 
      type: "object", 
      properties: { 
        image_index: { type: "integer", description: "Index of the image in session (0 for the first/only image)." },
        remote_path: { type: "string", description: "Full target path on the remote machine." }
      }, 
      required: ["image_index", "remote_path"] 
    },
    handler: async (args, sessionImages) => {
      try {
        relayLog(`[DEBUG] push_uploaded_image called with: ${JSON.stringify(args)}`);

        if (args.image_index === undefined && sessionImages && sessionImages.length === 1) {
          args.image_index = 0;
          relayLog(`[DEBUG] Defaulting image_index to 0`);
        }

        if (!sessionImages || sessionImages[args.image_index] === undefined) throw new Error(`No image found at index ${args.image_index}.`);
        
        let targetPath = args.remote_path || args.destination || args.path || args.target;
        if (!targetPath || targetPath === "undefined") {
          targetPath = `./uploads/image_${Date.now()}.jpg`;
          relayLog(`[DEBUG] No remote_path provided, defaulting to ${targetPath}`);
        } else if (targetPath.endsWith('/') || targetPath.endsWith('\\')) {
          targetPath = path.join(targetPath, `image_${Date.now()}.jpg`).replace(/\\/g, '/');
          relayLog(`[DEBUG] Directory provided, resolved to ${targetPath}`);
        }

        const buffer = Buffer.from(sessionImages[args.image_index], 'base64');
        const uploadUrl = `${CONFIG.RESOURCE_MCP_URL}/upload?path=${encodeURIComponent(targetPath)}`;

        const response = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'X-Auth-Token': CONFIG.AUTH_TOKEN },
          body: buffer,
          duplex: 'half'
        });

        if (!response.ok) throw new Error(await response.text());
        return { content: [{ type: "text", text: `SUCCESS: Session image pushed directly to remote ${targetPath}` }] };
      } catch (e) { return { isError: true, content: [{ type: "text", text: e.message }] }; }
    }
  },
  {
    name: "list_local_directory",
    description: "List files and directories in a local path on the Executor machine.",
    inputSchema: { type: "object", properties: { path: { type: "string", default: "." } } },
    handler: async (args) => ({ content: [{ type: "text", text: fs.readdirSync(path.resolve(args.path || ".")).join('\n') }] })
  },
  {
    name: "delete_local_file",
    description: "Delete a file from the local Executor machine.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    handler: async (args) => {
      fs.unlinkSync(path.resolve(args.path));
      return { content: [{ type: "text", text: `Successfully deleted local file: ${args.path}` }] };
    }
  },
  {
    name: "save_uploaded_file",
    description: "Save a non-image file uploaded via WebUI to the local 'uploads/' directory.",
    inputSchema: { 
      type: "object", 
      properties: { 
        file_index: { type: "integer", description: "Index of the file in the current session (0 for the first file)." },
        filename: { type: "string", description: "Optional: override original filename." }
      }, 
      required: ["file_index"] 
    },
    handler: async (args, sessionImages, sessionFiles) => {
      try {
        relayLog(`[DEBUG] save_uploaded_file called with index: ${args.file_index}`);
        if (sessionFiles) {
           relayLog(`[DEBUG] sessionFiles length: ${sessionFiles.length}`);
           sessionFiles.forEach((f, i) => relayLog(`[DEBUG] File ${i}: ${f.name} (${f.data ? f.data.length : 'no data'} bytes)`));
        }
        if (!sessionFiles || !sessionFiles[args.file_index]) throw new Error("No file found at that index.");
        const file = sessionFiles[args.file_index];
        const targetName = args.filename || file.name;
        const uploadsDir = path.join(process.cwd(), 'uploads');
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
        
        const fullPath = path.join(uploadsDir, targetName);
        fs.writeFileSync(fullPath, Buffer.from(file.data, 'base64'));
        return { content: [{ type: "text", text: `SUCCESS: File saved to local uploads/ folder: ${targetName}` }] };
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

  // 强化系统指令：明确“参数屏蔽”机制
  const expertSystemPrompt = `${skill.system}\n\n### MANDATORY ARCHITECTURAL PROTOCOL\n1. TOOL DISCOVERY: To minimize errors, tool parameters are HIDDEN by default. \n2. RESEARCH REQUIREMENT: You MUST call 'get_tool_usage' for any tool you wish to use. This will return the correct JSON Schema.\n3. ZERO GUESSING: Do not attempt to guess parameters. If you call a tool with incorrect or guessed arguments, the system will reject it.`;

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
          const toolLog = `[Executor] Tool Call: ${call.function.name}`;
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

async function handleMcpUpdate() {
  const remoteRoot = 'D:/project/mcp_server';
  const localMcpRoot = path.join(__dirname, 'mcp_server');
  try {
    const serverContent = fs.readFileSync(path.join(localMcpRoot, 'mcp_server.js')).toString('base64');
    await fetch(`${CONFIG.RESOURCE_MCP_URL}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'receive_file', arguments: { path: `${remoteRoot}/mcp_server.js`, base64_content: serverContent } }) });
    return "Sync successful.";
  } catch(e) { return `Sync failed: ${e.message}`; }
}

async function handlePullScripts() {
  return "Pulling scripts... (Feature restored)";
}

async function runNativeMcpUpdate() {
  const localRoot = path.join(__dirname, 'mcp_server');
  const remoteRoot = 'D:/project/mcp_server';
  let logs = ["[Native Update] Starting synchronization..."];
  
  const syncFile = async (localPath, remotePath) => {
    try {
      if (!fs.existsSync(localPath)) return;
      const content = fs.readFileSync(localPath).toString('base64');
      await fetch(`${CONFIG.RESOURCE_MCP_URL}/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'receive_file', arguments: { path: remotePath, base64_content: content } })
      });
      const log = `[Native Sync] Sent: ${path.relative(localRoot, localPath)}`;
      console.log(`${STYLES.dim}${log}${STYLES.reset}`);
      relayLog(log);
      logs.push(log);
    } catch(e) {
      const errLog = `[Native Sync Error] Failed ${localPath}: ${e.message}`;
      console.error(errLog);
      relayLog(errLog);
      logs.push(errLog);
    }
  };

  await syncFile(path.join(localRoot, 'mcp_server.js'), `${remoteRoot}/mcp_server.js`);
  await syncFile(path.join(localRoot, 'package.json'), `${remoteRoot}/package.json`);
  await syncFile(path.join(__dirname, 'config.json'), `${remoteRoot}/config.json`);

  const toolsDir = path.join(localRoot, 'tools');
  if (fs.existsSync(toolsDir)) {
    const files = fs.readdirSync(toolsDir);
    for (const f of files) {
      await syncFile(path.join(toolsDir, f), `${remoteRoot}/tools/${f}`);
    }
  }

  const scriptsDir = path.join(localRoot, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    const files = fs.readdirSync(scriptsDir);
    for (const f of files) {
      await syncFile(path.join(scriptsDir, f), `${remoteRoot}/scripts/${f}`);
    }
  }

  return logs.join('\n');
}

async function runNativePullScripts() {
  const localScriptsDir = path.join(__dirname, 'mcp_server', 'scripts');
  if (!fs.existsSync(localScriptsDir)) fs.mkdirSync(localScriptsDir, { recursive: true });
  
  try {
    const res = await fetch(`${CONFIG.RESOURCE_MCP_URL}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'list_directory', arguments: { dir_path: 'D:/project/mcp_server/scripts' } })
    });
    const data = await res.json();
    const files = data.content?.[0]?.text.split('\n') || [];
    
    for (const f of files) {
      if (!f.trim()) continue;
      const fileRes = await fetch(`${CONFIG.RESOURCE_MCP_URL}/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'read_file', arguments: { file_path: `D:/project/mcp_server/scripts/${f}` } })
      });
      const fileData = await fileRes.json();
      fs.writeFileSync(path.join(localScriptsDir, f), fileData.content[0].text);
      relayLog(`[Native Pull] Saved: ${f}`);
    }
    return "All scripts pulled natively.";
  } catch(e) { return `Pull failed: ${e.message}`; }
}

app.post("/call", async (req, res) => 
{
  const { name, arguments: args, skill_name, images, files } = req.body;
  
  if (files && files.length > 0) {
    relayLog(`[DEBUG] /call received ${files.length} files`);
  }

  if (skill_name === 'mcp_updater') {
    const result = await runNativeMcpUpdate();
    return res.json({ content: [{ type: "text", text: result }], tokens: { prompt: 0, completion: 0 } });
  }
  if (skill_name === 'pull_scripts') {
    const result = await runNativePullScripts();
    return res.json({ content: [{ type: "text", text: result }], tokens: { prompt: 0, completion: 0 } });
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
  const msg = `Executor ready on ${CONFIG.EXECUTOR_PORT}`;
  app.listen(CONFIG.EXECUTOR_PORT, "0.0.0.0", () => {
    console.log(msg);
    relayLog(msg);
  });
}
start();
