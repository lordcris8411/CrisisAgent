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
const activatedTools = new Map(); // tool_name -> execution_id

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

  // 预览模式逻辑：如果 view=1，则不强制下载
  if (req.query.view === '1') {
    console.log(`${STYLES.cyan}[PREVIEW] Viewing file: ${absolutePath}${STYLES.reset}`);
    const ext = path.extname(absolutePath).toLowerCase();
    if (ext === '.pdf') {
      res.setHeader('Content-Type', 'application/pdf');
    }
    res.setHeader('Content-Disposition', 'inline');
    return res.sendFile(absolutePath);
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
  const { name, arguments: args, tool_name, clientHost, execution_id } = req.body;
  const requestHost = clientHost || req.headers.host || "localhost:3000";

  try 
  {
    // 处理 Discovery 协议：获取工具用法
    if (name === "get_tool_usage") {
      const targetName = tool_name || args?.tool_name;
      const target = TOOL_DEFINITIONS.find(t => t.name === targetName);
      if (!target) return res.status(404).json({ isError: true, content: [{ type: 'text', text: `Tool ${targetName} not found` }] });
      
      // 激活工具，绑定当前 Execution ID
      activatedTools.set(targetName, execution_id);
      console.log(`${STYLES.green}[DISCOVERY] Tool '${targetName}' unlocked for Execution ID: ${execution_id}${STYLES.reset}`);
      
      return res.json({ 
        content: [{ 
          type: 'text', 
          text: `--- TOOL ACTIVATED ---\nName: ${target.name}\nDescription: ${target.description}\nUsage Schema: ${JSON.stringify(target.inputSchema, null, 2)}` 
        }] 
      });
    }

    // 安全检查：强制执行“先研究再执行”协议
    // 环境信息工具 get_env_info 始终允许
    if (name !== 'get_env_info') {
      const allowedId = activatedTools.get(name);
      if (allowedId === undefined || allowedId !== execution_id) {
        const msg = `[PROTOCOL VIOLATION] Tool '${name}' is LOCKED for ID ${execution_id}. As an expert, you MUST first call 'get_tool_usage' with tool_name='${name}' to retrieve the official schema and safety constraints for THIS execution session. Discovery is mandatory.`;
        console.log(`${STYLES.red}${msg}${STYLES.reset}`);
        return res.json({ isError: true, content: [{ type: 'text', text: msg }] });
      }
    }

    // 寻找能处理该工具的模块
    for (const mod of modules)
    {
      if (mod.definitions.find(d => d.name === name))
      {
        try
        {
          const result = await mod.handle(name, args, requestHost);
          console.log(`${STYLES.green}[SUCCESS] ${name} executed for ID: ${execution_id}${STYLES.reset}`);
          
          // 执行后不再自动重新锁定，允许在同一个 ID 内重复使用
          
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
