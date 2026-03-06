const express = require("express");
const cors = require("cors");
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const STYLES = { reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', dim: '\x1b[2m', yellow: '\x1b[33m' };

// 加载配置
let CONFIG = { AUTH_TOKEN: "CRISIS_AGENT_SECURE_TOKEN_2026" };
try {
  const configPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(configPath)) {
    CONFIG = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log(`${STYLES.green}[AUTH] Configuration loaded from config.json.${STYLES.reset}`);
  }
} catch (e) {
  console.log(`${STYLES.yellow}[WARN] Error loading config.json: ${e.message}${STYLES.reset}`);
}

function safeRequire(modulePath)
{
  try 
  {
    return require(modulePath);
  } 
  catch (e) 
  {
    console.error(`${STYLES.red}[LOAD ERROR] Failed to load ${modulePath}: ${e.message}${STYLES.reset}`);
    return { definitions: [], handle: async () => ({ isError: true, content: [{ type: 'text', text: `Module ${modulePath} failed to load: ${e.message}` }] }) };
  }
}

const fileOps = safeRequire('./tools/file_ops');
const systemOps = safeRequire('./tools/system_ops');
const clipboardOps = safeRequire('./tools/clipboard_ops');
const automationOps = safeRequire('./tools/automation_ops');
const sshOps = safeRequire('./tools/ssh_ops');
const archiveOps = safeRequire('./tools/archive_ops');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

// --- Streaming Endpoints with Security ---

function checkAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (token !== CONFIG.AUTH_TOKEN) {
    console.log(`${STYLES.red}[SECURITY] Blocked unauthorized access attempt from ${req.ip}${STYLES.reset}`);
    return res.status(401).send("Unauthorized: Invalid Token");
  }
  next();
}

// 流式下载接口 (Remote -> Local)
app.get("/download", checkAuth, (req, res) => {
  const filePath = req.query.path;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).send("File not found");
  }
  const stats = fs.statSync(filePath);
  res.setHeader('Content-Length', stats.size);
  res.setHeader('Content-Type', 'application/octet-stream');
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
});

// 流式上传接口 (Local -> Remote)
app.post("/upload", checkAuth, (req, res) => {
  const targetPath = req.query.path;
  if (!targetPath) return res.status(400).send("Path required");
  
  fs.mkdirSync(path.dirname(path.resolve(targetPath)), { recursive: true });
  const writeStream = fs.createWriteStream(targetPath);
  
  req.pipe(writeStream);
  
  writeStream.on('finish', () => res.send({ success: true }));
  writeStream.on('error', (err) => res.status(500).send(err.message));
});

// 增加基础错误处理器
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error(`[SERVER] JSON Syntax Error: ${err.message}`);
    return res.status(400).send({ isError: true, content: [{ type: 'text', text: "Invalid JSON payload" }] });
  }
  next();
});

// 设置标题
try { if (process.platform === 'win32') execSync('title Crisis Agent MCP'); } catch (e) {}

const modules = [fileOps, systemOps, clipboardOps, automationOps, sshOps, archiveOps];
const TOOL_DEFINITIONS = 
[
  ...fileOps.definitions,
  ...systemOps.definitions,
  ...clipboardOps.definitions,
  ...automationOps.definitions,
  ...sshOps.definitions,
  ...archiveOps.definitions,
  { name: "get_tool_usage", description: "Get tool usage docs.", inputSchema: { type: "object", properties: { tool_name: { type: "string" } }, required: ["tool_name"] } }
];

// 工具激活状态追踪 (Discovery-First Protocol)
const activatedTools = new Set();

app.get("/list", (req, res) => 
{
  console.log(`${STYLES.cyan}[INFO] Tools list requested.${STYLES.reset}`);
  res.json({ tools: TOOL_DEFINITIONS });
});

app.post("/call", async (req, res) => 
{
  const { name, arguments: args } = req.body;
  const time = new Date().toLocaleTimeString();
  console.log(`${STYLES.bold}[${time}] [CALL] ${name}${STYLES.reset}`);
  
  if (name !== 'receive_file') console.log(`${STYLES.dim}Args: ${JSON.stringify(args)}${STYLES.reset}`);

  try
  {
    // --- Discovery-First Gatekeeping ---
    if (name === "get_tool_usage")
    {
      const tool = TOOL_DEFINITIONS.find(t => t.name === args.tool_name);
      if (tool) activatedTools.add(args.tool_name); // 激活该工具的使用权
      return res.json({ content: [{ type: "text", text: `--- TOOL ACTIVATED ---\nUsage Schema: ${JSON.stringify(tool?.inputSchema, null, 2)}` }] });
    }

    // 内部维护工具和已激活工具允许执行
    const isExempt = ["receive_file", "get_tool_usage"].includes(name);
    if (!isExempt && !activatedTools.has(name)) {
      const lockError = `[PROTOCOL VIOLATION] Tool '${name}' is currently LOCKED. As an expert, you MUST first call 'get_tool_usage' with tool_name='${name}' to retrieve the official schema and safety constraints before you can execute it. Discovery is mandatory.`;
      console.log(`${STYLES.red}${lockError}${STYLES.reset}`);
      return res.json({ isError: true, content: [{ type: 'text', text: lockError }] });
    }
    // ----------------------------------

    // 寻找能处理该工具的模块
    for (const mod of modules)
    {
      if (mod.definitions.find(d => d.name === name))
      {
        try
        {
          const result = await mod.handle(name, args);
          console.log(`${STYLES.green}[SUCCESS] ${name} done.${STYLES.reset}`);
          
          // --- Auto-Relock Mechanism ---
          // 成功调用后立即撤销激活状态，强制下一次调用前重新研究
          if (activatedTools.has(name)) {
            activatedTools.delete(name);
            console.log(`${STYLES.yellow}[SECURITY] Tool '${name}' has been RE-LOCKED after use.${STYLES.reset}`);
          }
          // -----------------------------

          // 打印返回结果简报
          if (result.content) {
            const textResult = result.content.filter(c => c.type === 'text').map(c => c.text).join(' ');
            const imageCount = result.content.filter(c => c.type === 'image').length;
            const preview = textResult.length > 100 ? textResult.substring(0, 100) + '...' : textResult;
            if (preview) console.log(`${STYLES.dim}Result: ${preview}${STYLES.reset}`);
            if (imageCount > 0) console.log(`${STYLES.dim}Result: [Contains ${imageCount} Image(s)]${STYLES.reset}`);
          }

          return res.json(result);
        }
        catch (modErr)
        {
          // 捕获模块内部抛出的原始错误并返回给客户端
          console.log(`${STYLES.red}[ERROR] ${name} inner failed: ${modErr.message}${STYLES.reset}`);
          return res.json({ isError: true, content: [{ type: 'text', text: `Module Error: ${modErr.message}` }] });
        }
      }
    }

    throw new Error(`Tool '${name}' not found.`);
  }
  catch (e)
  {
    console.log(`${STYLES.red}[ERROR] ${name} failed: ${e.message}${STYLES.reset}`);
    res.json({ isError: true, content: [{ type: 'text', text: e.message }] });
  }
});

const PORT = 3000;
app.listen(PORT, "0.0.0.0", () => 
{
  console.log(`${STYLES.bold}${STYLES.green}Modular MCP Server running at :${PORT}${STYLES.reset}\n`);
});
