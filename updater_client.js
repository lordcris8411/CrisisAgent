const fs = require('fs');
const path = require('path');

// --- Configuration ---
const TARGET_HOST = 'http://172.16.1.99:3003'; // 修改为目标机器的 IP
const AUTH_TOKEN = 'CRISIS_AGENT_SECURE_TOKEN_2026';
// ---------------------

async function runUpdate() {
    // 基础核心文件
    const coreFiles = [
        'cli.js',
        'executor_server.js',
        'updater_server.js',
        'start.js',
        'system.md',
        'exe_system.md',
        'GEMINI.md',
        'web/index.html'
    ];

    // 动态扫描目录
    const scanDirs = [
        'functions',
        'mcp_server/tools',
        'mcp_server/scripts'
    ];

    let filesToUpdate = coreFiles.map(f => ({ path: f, localPath: `./${f}` }));

    // 扫描并添加目录下的所有 .js 和 .func 文件
    for (const dir of scanDirs) {
        if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir);
            for (const f of files) {
                const fullPath = path.join(dir, f);
                if (fs.statSync(fullPath).isFile()) {
                    filesToUpdate.push({ path: fullPath.replace(/\\/g, '/'), localPath: `./${fullPath}` });
                }
            }
        }
    }

    const payload = { files: [] };

    for (const f of filesToUpdate) {
        if (fs.existsSync(f.localPath)) {
            payload.files.push({
                path: f.path,
                content: fs.readFileSync(f.localPath).toString('base64')
            });
            console.log(`[Prepared] ${f.path}`);
        } else {
            console.log(`[Skipped] ${f.path} (Not found locally)`);
        }
    }

    if (payload.files.length === 0) {
        console.log("No files found to update.");
        return;
    }

    console.log(`\nSending update request (${payload.files.length} files) to ${TARGET_HOST}...`);
    try {
        const res = await fetch(`${TARGET_HOST}/update`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'X-Auth-Token': AUTH_TOKEN
            },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            const data = await res.json();
            console.log("SUCCESS: System updated and reboot triggered.");
            console.log("Server Logs:");
            data.logs.forEach(l => console.log(`  ${l}`));
        } else {
            const errorText = await res.text();
            console.error(`FAILED: ${res.status} - ${errorText}`);
        }
    } catch (e) {
        console.error("Network error:", e.message);
    }
}

runUpdate();
