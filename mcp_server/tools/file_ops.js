const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const definitions = 
[
  { name: "read_file", description: "Read the full text content of a file on the system. Supports UTF-8 encoding. Use for reading source code, logs, or configuration files.", inputSchema: { type: "object", properties: { path: { type: "string", description: "Absolute or relative path to the file." } }, required: ["path"] } },
  { name: "write_file", description: "Create a new file or overwrite an existing one with text content on the system. Automatically creates parent directories if they don't exist.", inputSchema: { type: "object", properties: { path: { type: "string", description: "Path where the file should be saved." }, content: { type: "string", description: "Text content to write." } }, required: ["path", "content"] } },
  { name: "append_file", description: "Append text content to the end of an existing file on the system without overwriting it.", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "delete_file", description: "Permanently delete a file from the disk. Use with caution.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "move_file", description: "Move a file or folder to a new location on the system.", inputSchema: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } }, required: ["source", "destination"] } },
  { name: "rename_file", description: "Change the name of a file or folder in its current directory.", inputSchema: { type: "object", properties: { path: { type: "string" }, new_name: { type: "string", description: "The new filename only, not the full path." } }, required: ["path", "new_name"] } },
  { name: "list_directory", description: "List all files and subdirectories within a specified path on the system. Defaults to the current working directory if no path is provided.", inputSchema: { type: "object", properties: { path: { type: "string", default: ".", description: "The directory to list." } } } },
  { name: "get_file_info", description: "Retrieve detailed metadata for a file or directory on the system, including size (in bytes), creation time, last modification time, and a downloadable HTTP URL.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "get_file_hash", description: "Calculate the SHA-256 hash of a file. Essential for verifying file integrity or detecting changes.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "web_fetch", description: "Perform an HTTP GET request to fetch content from a URL for analysis. Supports redirects.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "download_file", description: "Download a file from a URL directly to a specified local path. Supports redirects.", inputSchema: { type: "object", properties: { url: { type: "string" }, path: { type: "string" } }, required: ["url", "path"] } }
];

// 辅助函数：支持重定向的 HTTP 请求
async function requestWithRedirects(url, options = {}, maxRedirects = 5) {
  const http = url.startsWith('https') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = http.get(url, options, (res) => {
      // 处理重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) return reject(new Error("Too many redirects"));
        const nextUrl = new URL(res.headers.location, url).toString();
        return resolve(requestWithRedirects(nextUrl, options, maxRedirects - 1));
      }
      resolve(res);
    });
    req.on('error', reject);
  });
}

async function handle(name, args, requestHost = "localhost:3000")
{
  if (process.platform === 'win32') {
    for (const key in args) {
      if (typeof args[key] === 'string' && /^[a-zA-Z]:$/.test(args[key])) args[key] += "\\";
    }
  }

  switch (name)
  {
    case "get_file_hash":
    {
      if (!fs.existsSync(args.path)) return { isError: true, content: [{ type: "text", text: "File not found" }] };
      const hashSum = crypto.createHash('sha256');
      hashSum.update(fs.readFileSync(args.path));
      return { content: [{ type: "text", text: hashSum.digest('hex') }] };
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
      fs.renameSync(args.path, path.join(targetDir, args.new_name));
      return { content: [{ type: "text", text: `Renamed ${args.path} to ${args.new_name}` }] };

    case "list_directory":
      return { content: [{ type: "text", text: fs.readdirSync(args.path || ".").join('\n') }] };

    case "get_file_info":
    {
      const absolutePath = path.resolve(args.path);
      if (!fs.existsSync(absolutePath)) return { isError: true, content: [{ type: "text", text: `File not found: ${args.path}` }] };
      const stats = fs.statSync(absolutePath);
      const isDir = stats.isDirectory();
      let infoLines = [`File: ${path.basename(absolutePath)}`, `Size: ${(stats.size / 1024).toFixed(2)} KB`, `Created: ${stats.birthtime.toLocaleString()}`, `Modified: ${stats.mtime.toLocaleString()}`, `Is Directory: ${isDir}`];
      if (!isDir) infoLines.push(`Public Download URL: http://${requestHost}/download?path=${encodeURIComponent(absolutePath)}`);
      return { content: [{ type: "text", text: infoLines.join('\n') }] };
    }

    case "web_fetch":
    {
      try {
        const res = await requestWithRedirects(args.url);
        if (res.statusCode !== 200) throw new Error(`Status ${res.statusCode}`);
        return new Promise((resolve) => {
          let data = "";
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            const preview = data.length > 50000 ? data.substring(0, 50000) + "... [TRUNCATED]" : data;
            resolve({ content: [{ type: "text", text: preview }] });
          });
        });
      } catch (e) { return { isError: true, content: [{ type: "text", text: `Fetch error: ${e.message}` }] }; }
    }

    case "download_file":
    {
      try {
        const res = await requestWithRedirects(args.url);
        if (res.statusCode !== 200) throw new Error(`Status ${res.statusCode}`);
        fs.mkdirSync(path.dirname(path.resolve(args.path)), { recursive: true });
        const fileStream = fs.createWriteStream(args.path);
        return new Promise((resolve, reject) => {
          res.pipe(fileStream);
          fileStream.on('finish', () => {
            fileStream.close();
            resolve({ content: [{ type: "text", text: `Successfully downloaded ${args.url} to ${args.path}` }] });
          });
          fileStream.on('error', (err) => {
            fs.unlink(args.path, () => {});
            reject(err);
          });
        });
      } catch (e) { return { isError: true, content: [{ type: "text", text: `Download error: ${e.message}` }] }; }
    }
  }
}

module.exports = { definitions, handle };
