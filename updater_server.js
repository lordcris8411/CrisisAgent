const express = require("express");
const fs = require('fs');
const path = require('path');
const cors = require("cors");

const CONFIG = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const app = express();
app.use(cors());
app.use(express.json({ limit: '500mb' }));

const STYLES = { reset: '\x1b[0m', green: '\x1b[32m', cyan: '\x1b[36m', bold: '\x1b[1m', red: '\x1b[31m', yellow: '\x1b[33m' };

// Auth Middleware
function checkAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (token !== CONFIG.AUTH_TOKEN) {
    console.log(`${STYLES.red}[UPDATER] Blocked unauthorized access attempt from ${req.ip}${STYLES.reset}`);
    return res.status(401).send("Unauthorized: Invalid Token");
  }
  next();
}

app.post("/update", checkAuth, (req, res) => {
  const { files } = req.body;
  
  if (!files || !Array.isArray(files)) {
    return res.status(400).send("Invalid request: 'files' array required.");
  }

  const projectRoot = __dirname;
  const logs = [];

  try {
    for (const file of files) {
      const targetPath = path.resolve(projectRoot, file.path);
      
      // Safety: Only allow writing WITHIN the project directory
      if (!targetPath.startsWith(projectRoot)) {
        throw new Error(`Permission denied: Path '${file.path}' is outside project root.`);
      }

      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const buffer = Buffer.from(file.content, 'base64');
      fs.writeFileSync(targetPath, buffer);
      
      const log = `[UPDATER] Updated: ${file.path}`;
      console.log(`${STYLES.cyan}${log}${STYLES.reset}`);
      logs.push(log);
    }

    res.json({ success: true, logs });
    
    // Trigger reboot after successful update
    console.log(`${STYLES.yellow}[UPDATER] System update complete. Rebooting...${STYLES.reset}`);
    setTimeout(() => process.exit(99), 1000);

  } catch (e) {
    console.error(`${STYLES.red}[UPDATER ERROR] ${e.message}${STYLES.reset}`);
    res.status(500).json({ success: false, error: e.message });
  }
});

const PORT = CONFIG.UPDATER_PORT || 3003;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`${STYLES.bold}${STYLES.green}[UPDATER] System Update Server running at :${PORT}${STYLES.reset}`);
});
