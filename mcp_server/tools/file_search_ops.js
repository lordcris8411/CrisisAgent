const fs = require('fs');
const path = require('path');

const STYLES = { reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', bold: '\x1b[1m' };

const definitions = [
  {
    name: "search_files",
    description: "Search for files in a directory matching a pattern (wildcards supported). Returns a list of matching file paths. Provides real-time progress to the server console. NOTE: The pattern '*.*' is forbidden; please use more specific filters.",
    inputSchema: {
      type: "object",
      properties: {
        root_path: {
          type: "string",
          description: "The directory to start the search from (e.g., '.', 'C:\\Users').",
          default: "."
        },
        pattern: {
          type: "string",
          description: "The filename pattern to search for. Supports wildcards like * and ? (e.g., '*.log', 'config.json'). Forbidden: '*.*'.",
          default: "*"
        },
        recursive: {
          type: "boolean",
          description: "Whether to search in subdirectories.",
          default: true
        },
        system_search: {
          type: "boolean",
          description: "If true, includes system/program/hidden directories (e.g., Windows, Program Files, node_modules). Defaults to false to ensure speed and focus.",
          default: false
        }
      },
      required: ["pattern"]
    }
  }
];

function wildcardToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&'); // Escape special regex chars except * and ?
  const regex = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${regex}$`, 'i');
}

// 定义需要跳过的系统目录
const SKIP_DIRS = ['Windows'];

async function handle(name, args, requestHost) {
  if (name === "search_files") {
    const rootPath = path.resolve(args.root_path || ".");
    const pattern = args.pattern;
    const recursive = args.recursive !== false;
    const systemSearch = args.system_search === true;

    // 拒绝 *.* 模式
    if (pattern === "*.*") {
      return { 
        isError: true, 
        content: [{ 
          type: "text", 
          text: "Error: The pattern '*.*' is forbidden to prevent system overload. Please use a more specific pattern (e.g., '*.txt') or use '*' to match files without extensions." 
        }] 
      };
    }

    const regex = wildcardToRegex(pattern);

    if (!fs.existsSync(rootPath)) {
      return { isError: true, content: [{ type: "text", text: `Path not found: ${rootPath}` }] };
    }

    const results = [];
    let scannedCount = 0;
    let matchCount = 0;
    const startTime = Date.now();

    console.log(`${STYLES.cyan}[SEARCH] Starting search for '${pattern}' in '${rootPath}' (recursive: ${recursive}, system_search: ${systemSearch})${STYLES.reset}`);

    function scan(dir) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          
          if (entry.isDirectory()) {
            // 如果不是系统搜索，则仅跳过 Windows 目录
            if (!systemSearch && entry.name.toLowerCase() === 'windows') {
              continue;
            }

            if (recursive) {
              scan(fullPath);
            }
          } else {
            scannedCount++;
            if (regex.test(entry.name)) {
              results.push(fullPath);
              matchCount++;
              if (matchCount % 50 === 0) {
                console.log(`${STYLES.yellow}[SEARCH PROGRESS] Matches: ${matchCount}, Scanned: ${scannedCount}${STYLES.reset}`);
              }
            }
          }
        }
      } catch (err) {
        // 静默处理无权限访问的目录
      }
    }

    scan(rootPath);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`${STYLES.green}[SEARCH COMPLETE] Found ${matchCount} matches among ${scannedCount} files in ${duration}s.${STYLES.reset}`);

    return { 
      content: [{ 
        type: "text", 
        text: results.length > 0 ? results.join('\n') : "No files matching the pattern were found." 
      }] 
    };
  }
}

module.exports = { definitions, handle };
