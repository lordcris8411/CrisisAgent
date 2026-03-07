const fs = require('fs');
const path = require('path');

const STYLES = { reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', bold: '\x1b[1m' };

const definitions = [
  {
    name: "search_files",
    description: "Search for files in a directory matching a pattern (wildcards supported). Returns a list of matching file paths. Provides real-time progress to the server console.",
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
          description: "The filename pattern to search for. Supports wildcards like * and ? (e.g., '*.log', 'config.json', 'test_??.py').",
          default: "*"
        },
        recursive: {
          type: "boolean",
          description: "Whether to search in subdirectories.",
          default: true
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

async function handle(name, args, requestHost) {
  if (name === "search_files") {
    const rootPath = path.resolve(args.root_path || ".");
    const pattern = args.pattern;
    const recursive = args.recursive !== false;
    const regex = wildcardToRegex(pattern);

    if (!fs.existsSync(rootPath)) {
      return { isError: true, content: [{ type: "text", text: `Path not found: ${rootPath}` }] };
    }

    const results = [];
    let scannedCount = 0;
    let matchCount = 0;
    const startTime = Date.now();

    console.log(`${STYLES.cyan}[SEARCH] Starting search for '${pattern}' in '${rootPath}' (recursive: ${recursive})${STYLES.reset}`);

    function scan(dir) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          
          if (entry.isDirectory()) {
            if (recursive) {
              scan(fullPath);
            }
          } else {
            scannedCount++;
            if (regex.test(entry.name)) {
              results.push(fullPath);
              matchCount++;
              // Every 10 matches or 1000 scanned, log a brief update
              if (matchCount % 50 === 0) {
                console.log(`${STYLES.yellow}[SEARCH PROGRESS] Matches: ${matchCount}, Scanned: ${scannedCount}${STYLES.reset}`);
              }
            }
          }
        }
      } catch (err) {
        console.error(`${STYLES.red}[SEARCH ERROR] Error scanning ${dir}: ${err.message}${STYLES.reset}`);
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
