/**
 * Description: This script retrieves detailed hardware configuration information of the computer.
 * It gathers:
 *   1. CPU Model and Load
 *   2. Total and Available Memory (RAM)
 *   3. Disk Space (Total, Used, Free) for the root drive
 *
 * Usage: node get_hardware_info.js
 * 
 * Requirements:
 *   - Node.js environment
 *   - Access to operating system APIs (os, fs modules)
 *
 * Note: This script handles cross-platform differences where applicable.
 */

const os = require('os');
const fs = require('fs');

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function getCPUInfo() {
    const arch = os.arch();
    const platform = os.platform();
    const cpus = os.cpus();
    
    // Node.js os.cpus() returns an array of model objects
    // We will show the model name of the first core as a representative, and total cores
    const firstCpu = cpus[0];
    return {
        model: firstCpu.model,
        speed: firstCpu.speed,
        cores: cpus.length,
        load: cpus.map(cpu => cpu.times.idle / (cpu.times.total || 1) * 100).reduce((a, b) => a + b, 0) / cpus.length // Approximate idle percent
    };
}

function getMemoryInfo() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    
    return {
        total: total,
        free: free,
        used: used,
        totalFormatted: formatBytes(total),
        freeFormatted: formatBytes(free),
        usedFormatted: formatBytes(used)
    };
}

function getDiskInfo() {
    const platform = os.platform();
    let rootPath;
    
    if (platform === 'win32') {
        rootPath = 'C:\\';
    } else {
        rootPath = '/';
    }
    
    try {
        const stats = fs.statSync(rootPath);
        // Note: Node.js 'stats' does not directly give disk usage in older versions.
        // However, 'os.freemem' is memory. For disk, we need to rely on 'os' specific logic or external tools.
        // Since we are in a sandbox, we will try to use os.freemem logic for disk if available, 
        // BUT the error earlier suggested `os.diskUsage` doesn't exist. 
        // In standard Node.js, `os.freemem` is for RAM. 
        // To get disk usage without external tools in standard Node.js, we often need to parse `df` (Linux/Mac) or `fsutil` (Windows).
        // Let's implement a cross-platform approach using exec for robustness.
        
        const { execSync } = require('child_process');
        let output;
        let diskData = {};

        if (platform === 'win32') {
            try {
                // Windows: Use wmic to get disk free space
                output = execSync('wmic logicaldisk get size,freespace,caption', { encoding: 'utf-8' });
                const lines = output.trim().split('\n');
                // Line 0: Header, Line 1: Data for C:, Line 2: Data for D:, etc.
                if (lines.length > 1) {
                    const parts = lines[1].trim().split('\s');
                    const size = parseInt(parts[0]);
                    const free = parseInt(parts[1]);
                    const label = parts[2];
                    diskData = {
                        drive: label,
                        total: size,
                        free: free,
                        used: size - free
                    };
                }
            } catch (e) {
                console.error('Failed to get disk info on Windows:', e.message);
            }
        } else {
            // Linux/Mac: Use df
            output = execSync(`df -h ${rootPath}`, { encoding: 'utf-8' });
            const lines = output.trim().split('\n');
            // Line 0: Header, Line 1: Data
            if (lines.length > 1) {
                const parts = lines[1].split(/\s+/);
                const total = parts[1]; // e.g., 100G
                const used = parts[2];
                const free = parts[3];
                diskData = {
                    drive: rootPath,
                    total: total,
                    used: used,
                    free: free,
                    note: 'Disk units in df are human-readable (e.g., 100G)'
                };
            }
        }
        return diskData;
    } catch (err) {
        console.error('Error retrieving disk usage:', err.message);
        return { error: 'Could not retrieve disk usage' };
    }
}

function main() {
    try {
        console.log('--- System Hardware Information ---');
        
        const cpu = getCPUInfo();
        console.log('CPU Model:', cpu.model);
        console.log('CPU Speed:', cpu.speed, 'MHz');
        console.log('Cores:', cpu.cores);
        
        const mem = getMemoryInfo();
        console.log('---');
        console.log('Memory (RAM):');
        console.log('  Total:', mem.totalFormatted);
        console.log('  Used:', mem.usedFormatted);
        console.log('  Free:', mem.freeFormatted);
        
        const disk = getDiskInfo();
        console.log('---');
        console.log('Disk Space:');
        if (disk.note) {
            console.log(`  Drive: ${disk.drive}`);
            console.log(`  Total: ${disk.total}`);
            console.log(`  Used: ${disk.used}`);
            console.log(`  Free: ${disk.free}`);
        } else if (disk.total) {
            console.log(`  Drive: ${disk.drive}`);
            console.log(`  Total: ${formatBytes(disk.total)}`);
            console.log(`  Used: ${formatBytes(disk.used)}`);
            console.log(`  Free: ${formatBytes(disk.free)}`);
        } else {
            console.log('  Could not retrieve disk usage.');
        }
        
        console.log('--- End of Report ---');
        
    } catch (err) {
        console.error('An error occurred:', err.message);
    }
}

main();
