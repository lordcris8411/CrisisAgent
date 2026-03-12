const express = require("express");
const cors = require("cors");
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const STYLES = { reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', bold: '\x1b[1m' };

const app = express();
app.use(cors());
app.use(express.json());

const toolsDir = path.join(__dirname, "tools");
const modules = fs.readdirSync(toolsDir)
  .filter(f => f.endsWith(".js"))
  .map(f => require(path.join(toolsDir, f)));

const TOOL_DEFINITIONS = modules.flatMap(m => m.definitions);
const activatedTools = new Map();

app.get("/list", (req, res) => {
  res.json({ tools: TOOL_DEFINITIONS });
});

app.get("/download", (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send("Path is required");
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) return res.status(404).send("File not found");

  if (req.query.view === '1') {
    const ext = path.extname(absolutePath).toLowerCase();
    if (ext === '.pdf') res.setHeader('Content-Type', 'application/pdf');
    else if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) res.setHeader('Content-Type', `image/${ext.slice(1)}`);
    res.setHeader('Content-Disposition', 'inline');
    return res.sendFile(absolutePath);
  }

  res.download(absolutePath);
});

app.post("/call", async (req, res) => {
  const { name, arguments: args, tool_name, clientHost, execution_id } = req.body;
  const requestHost = clientHost || req.headers.host || "localhost:3000";
  try {
    if (name === "get_tool_usage") {
      const targetName = tool_name || args?.tool_name;
      const target = TOOL_DEFINITIONS.find(t => t.name === targetName);
      if (!target) return res.status(404).json({ isError: true, content: [{ type: 'text', text: `Tool ${targetName} not found` }] });
      activatedTools.set(targetName, execution_id);
      return res.json({ content: [{ type: 'text', text: `Tool Activated: ${target.name}\nSchema: ${JSON.stringify(target.inputSchema, null, 2)}` }] });
    }
    if (name !== 'get_env_info') {
      const allowedId = activatedTools.get(name);
      if (allowedId === undefined || allowedId !== execution_id) {
        return res.json({ isError: true, content: [{ type: 'text', text: `[LOCKED] Call get_tool_usage for '${name}' first.` }] });
      }
    }
    for (const mod of modules) {
      if (mod.definitions.find(d => d.name === name)) {
        const result = await mod.handle(name, args, requestHost);
        return res.json(result);
      }
    }
    res.status(404).json({ isError: true, content: [{ type: 'text', text: `Tool ${name} not found` }] });
  } catch (e) {
    res.status(500).json({ isError: true, content: [{ type: 'text', text: e.message }] });
  }
});

app.listen(3000, "0.0.0.0", () => console.log(`MCP Server on 3000`));
