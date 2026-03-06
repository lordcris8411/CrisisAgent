const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const definitions = [
  {
    name: "archive_extract",
    description: "Extract common archive files (zip, rar, 7z, tar, gz) using 7-Zip.",
    inputSchema: {
      type: "object",
      properties: {
        archive_path: { type: "string", description: "Path to the archive file." },
        output_dir: { type: "string", description: "Directory to extract files into. Defaults to a folder with the same name." }
      },
      required: ["archive_path"]
    }
  },
  {
    name: "archive_compress",
    description: "Compress files or folders into an archive using 7-Zip.",
    inputSchema: {
      type: "object",
      properties: {
        source_path: { type: "string", description: "File or folder to compress." },
        dest_path: { type: "string", description: "Destination archive path (e.g., backup.7z, data.zip)." },
        format: { type: "string", enum: ["7z", "zip", "tar"], default: "7z" }
      },
      required: ["source_path", "dest_path"]
    }
  }
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

  // 假设 7z.exe 已安装并在环境变量中，或者在固定路径
  const SEVEN_ZIP = "7z"; 

  switch (name)
  {
    case "archive_extract":
      try
      {
        const outDir = args.output_dir || args.archive_path.replace(/\.[^/.]+$/, "");
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        
        // x: 完整路径解压, -o: 输出目录, -y: 自动覆盖
        const cmd = `"${SEVEN_ZIP}" x "${args.archive_path}" -o"${outDir}" -y`;
        execSync(cmd);
        return { content: [{ type: "text", text: `Successfully extracted to: ${outDir}` }] };
      }
      catch (e)
      {
        return { isError: true, content: [{ type: "text", text: `Extraction failed: ${e.message}` }] };
      }

    case "archive_compress":
      try
      {
        // a: 添加到压缩包, -t: 指定格式
        const fmt = args.format || "7z";
        const cmd = `"${SEVEN_ZIP}" a -t${fmt} "${args.dest_path}" "${args.source_path}" -y`;
        execSync(cmd);
        return { content: [{ type: "text", text: `Successfully compressed to: ${args.dest_path}` }] };
      }
      catch (e)
      {
        return { isError: true, content: [{ type: "text", text: `Compression failed: ${e.message}` }] };
      }

    default:
      throw new Error(`Unknown archive tool: ${name}`);
  }
}

module.exports = { definitions, handle };
