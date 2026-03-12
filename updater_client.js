console.log(`Operation Time: 2026-03-07 20:01:45`);
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const TARGET_HOST = 'http://172.16.1.100:3003'; // 修改为目标机器的 IP
const AUTH_TOKEN = 'CRISIS_AGENT_SECURE_TOKEN_2026';
// ---------------------

async function runUpdate() {
    const args = process.argv.slice(2);
    const mode = args.includes('--prompt') ? 'prompt' : (args.includes('--web') ? 'web' : 'full');
    
    console.log(`[Mode] Update scope: ${mode.toUpperCase()}`);

    // 基础核心文件定义
    const allCoreFiles = [
        'cli.js',
        'executor_server.js',
        'mcp_server/mcp_server.js',
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

    let filesToUpdate = [];

    // 根据模式过滤文件
    if (mode === 'prompt') {
        // 仅提示词相关
        filesToUpdate.push({ path: 'system.md', localPath: './system.md' });
        filesToUpdate.push({ path: 'exe_system.md', localPath: './exe_system.md' });
        // 添加所有技能定义文件
        if (fs.existsSync('functions')) {
            const funcs = fs.readdirSync('functions').filter(f => f.endsWith('.func'));
            funcs.forEach(f => filesToUpdate.push({ path: `functions/${f}`, localPath: `./functions/${f}` }));
        }
    } else if (mode === 'web') {
        // 仅网页相关
        filesToUpdate.push({ path: 'web/index.html', localPath: './web/index.html' });
    } else {
        // 全量模式
        filesToUpdate = allCoreFiles.map(f => ({ path: f, localPath: `./${f}` }));
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
        console.log("No files found to update for this scope.");
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
            console.log(`SUCCESS: System updated (${mode}) and reboot triggered.`);
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
