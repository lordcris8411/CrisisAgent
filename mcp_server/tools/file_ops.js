const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const definitions = 
[
  { name: "read_file", description: "Read the content of a text file.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to a file (overwrites if exists).", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "append_file", description: "Append content to an existing file.", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "delete_file", description: "Delete a file from the disk.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "move_file", description: "Move a file or folder to a new location.", inputSchema: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } }, required: ["source", "destination"] } },
  { name: "rename_file", description: "Rename a file or folder.", inputSchema: { type: "object", properties: { path: { type: "string" }, new_name: { type: "string" } }, required: ["path", "new_name"] } },
  { name: "list_directory", description: "List files and directories in a path.", inputSchema: { type: "object", properties: { path: { type: "string", default: "." } } } },
  { name: "list_scripts", description: "List all existing JavaScript files in the 'scripts/' directory.", inputSchema: { type: "object", properties: {} } },
  { name: "get_file_info", description: "Get detailed metadata of a file (size, creation time, modification time).", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "get_file_hash", description: "Calculate SHA-256 hash of a file to check for integrity or changes.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "download_file", description: "Download a file from a URL to the remote machine.", inputSchema: { type: "object", properties: { url: { type: "string" }, dest_path: { type: "string" } }, required: ["url", "dest_path"] } },
  { name: "web_fetch", description: "Fetch the text/HTML content of a URL directly. Useful for web scraping or analysis.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "receive_file", description: "Internal tool for file synchronization (binary support).", inputSchema: { type: "object", properties: { path: { type: "string" }, base64_content: { type: "string" } }, required: ["path", "base64_content"] } },
  { name: "pull_file", description: "Read any file as base64 for downloading from remote to local.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }
];

async function handle(name, args)
{
  // Path normalization for Windows drive letters: "D:" -> "D:\"
  if (process.platform === 'win32')
  {
    for (const key in args)
    {
      if (typeof args[key] === 'string' && /^[a-zA-Z]:$/.test(args[key]))
      {
        args[key] += "\\";
      }
    }
  }

  switch (name)
  {
    case "get_file_hash":
    {
      if (!fs.existsSync(args.path)) return { isError: true, content: [{ type: "text", text: "File not found" }] };
      const fileBuffer = fs.readFileSync(args.path);
      const hashSum = crypto.createHash('sha256');
      hashSum.update(fileBuffer);
      return { content: [{ type: "text", text: hashSum.digest('hex') }] };
    }

    case "download_file":
    {
      return new Promise((resolve) => {
        const url = require('url');
        const http = args.url.startsWith('https') ? require('https') : require('http');
        
        fs.mkdirSync(path.dirname(path.resolve(args.dest_path)), { recursive: true });
        const file = fs.createWriteStream(args.dest_path);
        
        http.get(args.url, (response) => {
          if (response.statusCode !== 200) {
            resolve({ isError: true, content: [{ type: "text", text: `Download failed: Status ${response.statusCode}` }] });
            return;
          }
          response.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve({ content: [{ type: "text", text: `Downloaded successfully to ${args.dest_path}` }] });
          });
        }).on('error', (err) => {
          fs.unlink(args.dest_path, () => {});
          resolve({ isError: true, content: [{ type: "text", text: `Download error: ${err.message}` }] });
        });
      });
    }

    case "read_file":
      return { content: [{ type: "text", text: fs.readFileSync(args.path, 'utf8') }] };

    case "write_file":
      fs.mkdirSync(path.dirname(path.resolve(args.path)), { recursive: true });
      fs.writeFileSync(args.path, args.content, 'utf8');
      return { content: [{ type: "text", text: `Successfully wrote to ${args.path}` }] };

    case "append_file":
      fs.appendFileSync(args.path, args.content, 'utf8');
      return { content: [{ type: "text", text: `Successfully appended to ${args.path}` }] };

    case "delete_file":
      fs.unlinkSync(args.path);
      return { content: [{ type: "text", text: `Successfully deleted ${args.path}` }] };

    case "move_file":
      fs.mkdirSync(path.dirname(path.resolve(args.destination)), { recursive: true });
      fs.renameSync(args.source, args.destination);
      return { content: [{ type: "text", text: `Moved ${args.source} to ${args.destination}` }] };

    case "rename_file":
      const targetDir = path.dirname(path.resolve(args.path));
      const targetPath = path.join(targetDir, args.new_name);
      fs.renameSync(args.path, targetPath);
      return { content: [{ type: "text", text: `Renamed ${args.path} to ${args.new_name}` }] };

    case "list_directory":
      return { content: [{ type: "text", text: fs.readdirSync(args.path || ".").join('\n') }] };

    case "list_scripts":
    {
      const scriptsDir = path.join(__dirname, '../scripts');
      if (!fs.existsSync(scriptsDir)) fs.mkdirSync(scriptsDir, { recursive: true });
      const files = fs.readdirSync(scriptsDir).filter(f => f.endsWith('.js'));
      
      const scriptInfos = files.map(f => {
        const fullPath = path.join(scriptsDir, f);
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split('\n');
        // 尝试从前几行寻找 // Description:
        let description = "(No description found)";
        for (let i = 0; i < Math.min(5, lines.length); i++) {
          if (lines[i].includes('Description:')) {
            description = lines[i].split('Description:')[1].trim();
            break;
          }
        }
        return `${f}: ${description}`;
      });

      return { content: [{ type: "text", text: scriptInfos.join('\n') || "(No scripts found)" }] };
    }

    case "get_file_info":
    {
      const stats = fs.statSync(args.path);
      const info = [
        `File: ${path.basename(args.path)}`,
        `Size: ${(stats.size / 1024).toFixed(2)} KB`,
        `Created: ${stats.birthtime.toLocaleString()}`,
        `Modified: ${stats.mtime.toLocaleString()}`,
        `Is Directory: ${stats.isDirectory()}`
      ].join('\n');
      return { content: [{ type: "text", text: info }] };
    }

    case "web_fetch":
    {
      return new Promise((resolve) => {
        const http = args.url.startsWith('https') ? require('https') : require('http');
        http.get(args.url, (res) => {
          if (res.statusCode !== 200) {
            resolve({ isError: true, content: [{ type: "text", text: `Fetch failed: Status ${res.statusCode}` }] });
            return;
          }
          let data = "";
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            // 简单截断超长网页，防止 Token 爆炸
            const preview = data.length > 50000 ? data.substring(0, 50000) + '... [TRUNCATED]' : data;
            resolve({ content: [{ type: "text", text: preview }] });
          });
        }).on('error', (err) => {
          resolve({ isError: true, content: [{ type: "text", text: `Fetch error: ${err.message}` }] });
        });
      });
    }

    case "receive_file":
      const buffer = Buffer.from(args.base64_content, 'base64');
      const fullPath = path.resolve(args.path);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, buffer);
      return { content: [{ type: "text", text: `Saved ${fullPath}` }] };

    case "pull_file":
      const fBuf = fs.readFileSync(args.path);
      return { content: [{ type: "text", text: `BASE64_DATA:${fBuf.toString('base64')}` }] };
  }
}

module.exports = { definitions, handle };
