const screenshot = require('screenshot-desktop');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const STYLES = { red: '\x1b[31m', reset: '\x1b[0m' };

const definitions = 
[
  { name: "get_screen_resolution", description: "Get the dynamic screen resolution (width and height) of the primary monitor.", inputSchema: { type: "object", properties: {} } },
  { name: "capture_screen", description: "Capture the system desktop screen at its current native resolution. Returns a JPEG image.", inputSchema: { type: "object", properties: {} } },
  { name: "get_current_time", description: "Get system clock time in 'YYYY-MM-DD HH:mm:ss' format.", inputSchema: { type: "object", properties: {} } },
  { name: "get_system_stats", description: "Get CPU usage, memory usage, and free disk space on this machine.", inputSchema: { type: "object", properties: {} } },
  { name: "get_hardware_info", description: "Get detailed hardware specifications (CPU, RAM, GPU, OS) of this machine.", inputSchema: { type: "object", properties: {} } },
  { name: "get_env_info", description: "Get current system environment information including username and environment variables.", inputSchema: { type: "object", properties: {} } },
  { name: "get_process_list", description: "Get a list of currently running processes with their CPU and memory usage.", inputSchema: { type: "object", properties: { limit: { type: "integer", default: 20 } } } },
  { 
    name: "run_application", 
    description: "Launch a Windows application. RULES: 1. For GUI apps: Use 'notepad', 'chrome', 'calc'. 2. For Commands (ping, ipconfig, dir): MUST use app_name='cmd'. To KEEP window open: Use args=['/k', 'YOUR_COMMAND']. To CLOSE after finish: Use args=['/c', 'YOUR_COMMAND'].", 
    inputSchema: { type: "object", properties: { app_name: { type: "string" }, args: { type: "array", items: { type: "string" } } }, required: ["app_name"] } 
  },
  {
    name: "run_command_sync",
    description: "Execute a shell command and wait for it to finish. Returns the output.",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
  },
  {
    name: "run_command_detached",
    description: "Execute a shell command in the background without waiting for it to finish.",
    inputSchema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"] }
  },
  {
    name: "run_script_file",
    description: "Execute a named JavaScript file from the 'scripts/' directory and return the output.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "The filename of the script (e.g., 'get_network_info.js')" } }, required: ["name"] }
  },
  { name: "wait", description: "Pause server execution for X milliseconds. Useful between UI actions.", inputSchema: { type: "object", properties: { ms: { type: "integer", description: "Duration in milliseconds" } }, required: ["ms"] } }
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
    case "run_command_sync":
    {
      try
      {
        const output = execSync(args.command, { encoding: 'utf8' });
        return { content: [{ type: "text", text: output || "(No output)" }] };
      }
      catch (e)
      {
        return { isError: true, content: [{ type: "text", text: `Command failed: ${e.message}` }] };
      }
    }

    case "run_command_detached":
    {
      try
      {
        const child = spawn(args.command, { 
          detached: true, 
          stdio: 'ignore', 
          shell: true,
          cwd: args.cwd || process.cwd()
        });
        child.unref();
        return { content: [{ type: "text", text: `Command started in background: ${args.command}` }] };
      }
      catch (e)
      {
        return { isError: true, content: [{ type: "text", text: `Failed to start background command: ${e.message}` }] };
      }
    }

    case "run_script_file":
    {
      try
      {
        const scriptsDir = path.join(__dirname, '../scripts');
        const scriptPath = path.join(scriptsDir, args.name);
        if (!fs.existsSync(scriptPath)) throw new Error(`Script file '${args.name}' not found in scripts/ directory.`);
        
        const output = execSync(`node "${scriptPath}"`, { encoding: 'utf8' });
        return { content: [{ type: "text", text: output || "(No output)" }] };
      }
      catch (e)
      {
        return { isError: true, content: [{ type: "text", text: `Script execution failed: ${e.message}` }] };
      }
    }

    case "get_screen_resolution":
    {
      try
      {
        const psCommand = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Size | Select-Object -First 1 | ConvertTo-Json";
        const output = execSync(`powershell -Command "${psCommand}"`).toString();
        const size = JSON.parse(output);
        return { content: [{ type: "text", text: `Resolution: ${size.Width}x${size.Height}` }] };
      }
      catch (e)
      {
        return { isError: true, content: [{ type: "text", text: `Failed to get resolution: ${e.message}` }] };
      }
    }

    case "get_current_time":
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      return { content: [{ type: "text", text: `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` }] };

    case "get_system_stats":
    {
      try
      {
        const psCommand = `
          $cpu = (Get-Counter '\\Processor(_Total)\\% Processor Time' -ErrorAction SilentlyContinue).CounterSamples.CookedValue;
          if ($null -eq $cpu) { $cpu = (Get-WmiObject Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average }
          $os = Get-CimInstance Win32_OperatingSystem;
          $memTotal = $os.TotalVisibleMemorySize;
          $memFree = $os.FreePhysicalMemory;
          $disks = Get-CimInstance Win32_LogicalDisk | Where-Object {$_.DriveType -eq 3} | Select-Object DeviceID, FreeSpace, Size;
          
          @{
            CPUUsage = [Math]::Round($cpu, 2);
            TotalMemory = [Math]::Round($memTotal / 1024 / 1024, 2);
            UsedMemory = [Math]::Round(($memTotal - $memFree) / 1024 / 1024, 2);
            MemoryUsage = [Math]::Round((($memTotal - $memFree) / $memTotal) * 100, 2);
            Disks = $disks | ForEach-Object {
              $used = $_.Size - $_.FreeSpace;
              @{
                Drive = $_.DeviceID;
                FreeGB = [Math]::Round($_.FreeSpace / 1024 / 1024 / 1024, 2);
                UsedGB = [Math]::Round($used / 1024 / 1024 / 1024, 2);
                TotalGB = [Math]::Round($_.Size / 1024 / 1024 / 1024, 2);
                UsedPercent = [Math]::Round(($used / $_.Size) * 100, 2);
                FreePercent = [Math]::Round(($_.FreeSpace / $_.Size) * 100, 2);
              }
            }
          } | ConvertTo-Json -Depth 5
        `;
        const output = execSync(`powershell -NoProfile -Command "${psCommand.replace(/\n/g, ' ')}"`).toString();
        const stats = JSON.parse(output);
        
        let diskInfo = stats.Disks.map(d => `${d.Drive} [Free: ${d.FreeGB}GB (${d.FreePercent}%)] [Used: ${d.UsedGB}GB (${d.UsedPercent}%)] Total: ${d.TotalGB}GB`).join('\\n');
        const report = `CPU Usage: ${stats.CPUUsage}%\\nMemory: ${stats.UsedMemory}GB / ${stats.TotalMemory}GB (${stats.MemoryUsage}% Used)\\nDisks:\\n${diskInfo}`;
        
        return { content: [{ type: "text", text: report }] };
      }
      catch (e)
      {
        return { isError: true, content: [{ type: "text", text: `Failed to get system stats: ${e.message}` }] };
      }
    }

    case "get_hardware_info":
    {
      try
      {
        const psCommand = `
          $cpu = Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors | Select-Object -First 1;
          $os = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, OSArchitecture, Version | Select-Object -First 1;
          $mem = Get-CimInstance Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum;
          $gpu = Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM;
          
          $disks = Get-CimInstance Win32_DiskDrive | Select-Object Model, Size;
          $logicalDrives = Get-CimInstance Win32_LogicalDisk;
          $cameras = Get-CimInstance Win32_PnPEntity | Where-Object { $_.Service -eq 'usbvideo' -or $_.Caption -like '*camera*' };
          $usbDevices = Get-CimInstance Win32_USBHub | Select-Object Caption;

          $result = @{
            CPU = if ($cpu) { @{ Name = $cpu.Name; Cores = $cpu.NumberOfCores; Logical = $cpu.NumberOfLogicalProcessors } } else { @{ Name = "Unknown"; Cores = 0; Logical = 0 } };
            OS = if ($os) { @{ Caption = $os.Caption; Arch = $os.OSArchitecture } } else { @{ Caption = "Unknown"; Arch = "Unknown" } };
            TotalRAM_GB = [Math]::Round($mem.Sum / 1024 / 1024 / 1024, 2);
            GPU = if ($gpu) { @($gpu) | ForEach-Object { @{ Name = $_.Name; VRAM_GB = [Math]::Round([math]::Abs([double]$_.AdapterRAM) / 1024 / 1024 / 1024, 2) } } } else { @() };
            PhysicalDisks = if ($disks) { @($disks) | ForEach-Object { @{ Model = $_.Model; SizeGB = [Math]::Round($_.Size / 1024 / 1024 / 1024, 2) } } } else { @() };
            LogicalDrivesCount = if ($logicalDrives) { @($logicalDrives).Count } else { 0 };
            CameraCount = if ($cameras) { @($cameras).Count } else { 0 };
            USBPeripherals = if ($usbDevices) { @($usbDevices) | Select-Object -First 10 | ForEach-Object { $_.Caption } } else { @() };
          };
          $json = $result | ConvertTo-Json -Depth 5;
          [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
        `;
        const outputB64 = execSync(`powershell -NoProfile -Command "${psCommand.replace(/\n/g, ' ')}"`).toString().trim();
        const info = JSON.parse(Buffer.from(outputB64, 'base64').toString('utf8'));
        
        const gpuStr = (Array.isArray(info.GPU) ? info.GPU : [info.GPU]).filter(g => g).map(g => `${g.Name} (${g.VRAM_GB}GB VRAM)`).join(', ') || "Unknown";
        const diskStr = (Array.isArray(info.PhysicalDisks) ? info.PhysicalDisks : [info.PhysicalDisks]).filter(d => d).map(d => `${d.Model} (${d.SizeGB}GB)`).join(', ') || "Unknown";
        const usbStr = Array.isArray(info.USBPeripherals) ? info.USBPeripherals.join(', ') : (info.USBPeripherals || "None");

        const report = [
          `OS: ${info.OS.Caption} (${info.OS.Arch})`,
          `CPU: ${info.CPU.Name} (${info.CPU.Cores} Cores, ${info.CPU.Logical} Logical)`,
          `RAM: ${info.TotalRAM_GB} GB`,
          `GPU: ${gpuStr}`,
          `Physical Disks: ${diskStr}`,
          `Logical Drives: ${info.LogicalDrivesCount}`,
          `Cameras Found: ${info.CameraCount}`,
          `USB Peripherals (Top 10): ${usbStr}`
        ].join('\n');
        
        return { content: [{ type: "text", text: report }] };
      }
      catch (e)
      {
        return { isError: true, content: [{ type: "text", text: `Hardware Info Error: ${e.message}` }] };
      }
    }

    case "get_env_info":
    {
      const os = require('os');
      const userInfo = os.userInfo();
      const envVars = process.env;
      
      let report = `=== System Information ===\n`;
      report += `OS Name: ${os.type()} (${os.platform()})\n`;
      report += `OS Release: ${os.release()}\n`;
      report += `Architecture: ${os.arch()}\n`;
      report += `User: ${userInfo.username}\n`;
      report += `Home: ${userInfo.homedir}\n\n`;
      
      report += `Environment Variables:\n`;
      for (const [key, value] of Object.entries(envVars))
      {
        report += `${key}=${value}\n`;
      }
      return { content: [{ type: "text", text: report }] };
    }

    case "get_process_list":
    {
      try
      {
        const limit = args.limit || 20;
        const psCommand = `
          Get-Process | Sort-Object CPU -Descending | Select-Object -First ${limit} | ForEach-Object {
            @{
              Name = $_.ProcessName;
              ID = $_.Id;
              CPU = [Math]::Round($_.CPU, 2);
              MemoryMB = [Math]::Round($_.WorkingSet / 1024 / 1024, 2);
            }
          } | ConvertTo-Json -Depth 5
        `;
        const output = execSync(`powershell -NoProfile -Command "${psCommand.replace(/\n/g, ' ')}"`).toString();
        const processes = JSON.parse(output);
        
        const header = "Name".padEnd(25) + "ID".padEnd(10) + "CPU(s)".padEnd(10) + "Mem(MB)";
        const rows = (Array.isArray(processes) ? processes : [processes]).map(p => 
          `${p.Name.padEnd(25)}${String(p.ID).padEnd(10)}${String(p.CPU).padEnd(10)}${p.MemoryMB}`
        ).join('\n');
        
        return { content: [{ type: "text", text: `${header}\n${rows}` }] };
      }
      catch (e)
      {
        return { isError: true, content: [{ type: "text", text: `Failed to get process list: ${e.message}` }] };
      }
    }

    case "wait":
      await new Promise(resolve => setTimeout(resolve, args.ms));
      return { content: [{ type: "text", text: `Waited for ${args.ms}ms.` }] };

    case "capture_screen":
      const raw = await screenshot({ format: 'png' });
      const opt = await sharp(raw).jpeg({ quality: 80 }).toBuffer();
      return { content: [{ type: "image", data: opt.toString('base64'), mimeType: "image/jpeg" }] };
  }
}

module.exports = { definitions, handle };
