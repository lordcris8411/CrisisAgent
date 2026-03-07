const express = require("express");
const cors = require("cors");
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const STYLES = { reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', bold: '\x1b[1m' };

const app = express();
app.use(cors());
app.use(express.json());

// 动态加载工具模块
const toolsDir = path.join(__dirname, "tools");
const modules = fs.readdirSync(toolsDir)
  .filter(f => f.endsWith(".js"))
  .map(f => require(path.join(toolsDir, f)));

const TOOL_DEFINITIONS = modules.flatMap(m => m.definitions);
const activatedTools = new Set();

app.get("/list", (req, res) => 
{
  console.log(`${STYLES.cyan}[INFO] Tools list requested.${STYLES.reset}`);
  res.json({ tools: TOOL_DEFINITIONS });
});

app.get("/download", (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send("Path is required");
  
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  
  if (!fs.existsSync(absolutePath)) {
    return res.status(404).send("File not found");
  }

  console.log(`${STYLES.yellow}[DOWNLOAD] Serving file: ${absolutePath}${STYLES.reset}`);
  res.download(absolutePath, (err) => {
    if (err) {
      console.error(`${STYLES.red}[DOWNLOAD ERROR] ${err.message}${STYLES.reset}`);
      if (!res.headersSent) res.status(500).send("Error downloading file");
    }
  });
});

app.post("/call", async (req, res) => 
{
  const { name, arguments: args, tool_name, clientHost } = req.body;
  const requestHost = clientHost || req.headers.host || "localhost:3000";

  try 
  {
    // 处理 Discovery 协议：获取工具用法
    if (name === "get_tool_usage") {
      const targetName = tool_name || args?.tool_name;
      const target = TOOL_DEFINITIONS.find(t => t.name === targetName);
      if (!target) return res.status(404).json({ isError: true, content: [{ type: 'text', text: `Tool ${targetName} not found` }] });
      
      // 激活工具（解锁）
      activatedTools.add(targetName);
      
      return res.json({ 
        content: [{ 
          type: 'text', 
          text: `--- TOOL ACTIVATED ---\nName: ${target.name}\nDescription: ${target.description}\nUsage Schema: ${JSON.stringify(target.inputSchema, null, 2)}` 
        }] 
      });
    }

    // 安全检查：强制执行“先研究再执行”协议
    if (!activatedTools.has(name) && name !== 'get_env_info') {
      const msg = `[PROTOCOL VIOLATION] Tool '${name}' is currently LOCKED. As an expert, you MUST first call 'get_tool_usage' with tool_name='${name}' to retrieve the official schema and safety constraints before you can execute it. Discovery is mandatory.`;
      console.log(`${STYLES.red}${msg}${STYLES.reset}`);
      return res.json({ isError: true, content: [{ type: 'text', text: msg }] });
    }

    // 寻找能处理该工具的模块
    for (const mod of modules)
    {
      if (mod.definitions.find(d => d.name === name))
      {
        try
        {
          const result = await mod.handle(name, args, requestHost);
          console.log(`${STYLES.green}[SUCCESS] ${name} executed for host: ${requestHost}${STYLES.reset}`);
          
          // 执行后自动重新锁定 (强制每次都要 Discovery)
          activatedTools.delete(name);
          
          return res.json(result);
        } catch (e) {
          console.error(`${STYLES.red}[TOOL ERROR] ${name}: ${e.message}${STYLES.reset}`);
          return res.json({ isError: true, content: [{ type: 'text', text: e.message }] });
        }
      }
    }

    res.status(404).json({ isError: true, content: [{ type: 'text', text: `Tool ${name} not found` }] });
  } 
  catch (e) 
  {
    console.error(`${STYLES.red}[SYSTEM ERROR] ${e.message}${STYLES.reset}`);
    res.status(500).json({ isError: true, content: [{ type: 'text', text: e.message }] });
  }
});

const PORT = 3000;
app.listen(PORT, "0.0.0.0", () => 
{
  console.log(`${STYLES.bold}${STYLES.green}Modular MCP Server running at :${PORT}${STYLES.reset}\n`);
});
