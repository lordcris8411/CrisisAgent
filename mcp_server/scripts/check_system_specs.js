/**
 * @description A robust script to check system hardware specifications including GPU model, camera existence, disk size, and available space.
 * @usage This script should be run via 'run_script_file' with the name 'check_system_specs.js'.
 * @returns Outputs a detailed report of hardware capabilities and disk status.
 */
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');

function checkGPU() {
    const platform = os.platform();
    try {
        if (platform === 'linux') {
            try {
                const output = execSync('lspci | grep -i vga', { encoding: 'utf-8' });
                if (output.trim()) return `GPU detected: ${output.trim().split(' ')[3]}`;
            } catch (e) {}
            try {
                const output = execSync('lspci | grep -i display', { encoding: 'utf-8' });
                if (output.trim()) return `Display controller: ${output.trim().split(' ')[3]}`;
            } catch (e) {}
            return "No specific GPU info via lspci, using generic detection.";
        } else if (platform === 'win32') {
            try {
                const output = execSync('wmic path win32_video get name /value', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
                if (output.includes('Name=')) {
                    const name = output.match(/Name=(.+)/)[1];
                    return `GPU Model: ${name.trim()}`;
                }
            } catch (e) {
                // Fallback for environments where wmic is restricted
                return "GPU Model: Unable to query via WMIC (environment restriction).";
            }
        } else {
            return `GPU Model: Generic detection for ${platform}.`;
        }
        return "GPU Model: Not detected via standard tools.";
    } catch (err) {
        return `Error checking GPU: ${err.message}`;
    }
}

function checkCamera() {
    const platform = os.platform();
    try {
        if (platform === 'win32') {
            try {
                const output = execSync('wmic path win32_cameraiddev get DeviceID /value', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
                if (output.includes('DeviceID')) return "Camera Exists: Yes (Detected via WMIC).";
            } catch (e) {
                // If WMIC fails, check device manager via PowerShell or just say unknown
                return "Camera Exists: Status unknown (WMIC access denied or failed).";
            }
        } else if (platform === 'linux') {
            try {
                const output = execSync('ls /dev/video* 2>/dev/null || echo "no cameras"', { encoding: 'utf-8' });
                if (output.trim() && !output.includes('no cameras')) return "Camera Exists: Yes (Linux V4L2).";
            } catch (e) {
                return "Camera Exists: Unknown (ls /dev/video* failed).";
            }
        } else {
            return "Camera Exists: Generic check for macOS/Linux/Windows.";
        }
        return "Camera Exists: No cameras detected in standard paths.";
    } catch (err) {
        return `Error checking camera: ${err.message}`;
    }
}

function checkDiskSpace() {
    const platform = os.platform();
    try {
        if (platform === 'win32') {
            // Use wmic for reliable size/free space on Windows
            const output = execSync('wmic logicaldisk where "Caption="C:" get Size,FreeSpace,DeviceID /value', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
            let size = 0;
            let free = 0;
            output.split('\n').forEach(line => {
                if (line.includes('Size=')) size = parseInt(line.split('=')[1]);
                if (line.includes('FreeSpace=')) free = parseInt(line.split('=')[1]);
            });
            const sizeGB = (size / 1024 / 1024 / 1024).toFixed(2);
            const freeGB = (free / 1024 / 1024 / 1024).toFixed(2);
            return `Disk C: Total: ${sizeGB} GB, Free: ${freeGB} GB`;
        } else {
            // Use 'df' for Linux/macOS
            const output = execSync('df -h / | tail -1', { encoding: 'utf-8' });
            const parts = output.trim().split(/\s+/);
            // df output: Filesystem Size Used Avail Use% Mounted
            return `Disk /: Size: ${parts[1]}, Available: ${parts[3]}, Used: ${parts[2]}`;
        }
    } catch (err) {
        // Fallback for environments where execSync is restricted
        return `Disk Space: Unable to query via command line. Total RAM: ${os.totalmem() / 1024 / 1024 / 1024} GB`;
    }
}

console.log("--- System Hardware Specification ---");
console.log(`GPU Model: ${checkGPU()}`);
console.log(`Camera Exists: ${checkCamera()}`);
console.log(`Disk Info: ${checkDiskSpace()}`);
console.log("--- End of Report ---");
