const clipboardy = require('clipboardy');
const { execSync } = require('child_process');

const definitions = 
[
  { name: "copy_to_clipboard", description: "Copy to clipboard.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "paste_from_clipboard", description: "Read clipboard.", inputSchema: { type: "object", properties: {} } },
  { name: "simulate_paste", description: "Press Ctrl+V.", inputSchema: { type: "object", properties: { delay_ms: { type: "integer", default: 500 } } } }
];

async function handle(name, args)
{
  const cb = clipboardy.default || clipboardy;
  switch (name)
  {
    case "copy_to_clipboard":
      cb.writeSync(args.text);
      return { content: [{ type: "text", text: "Copied." }] };

    case "paste_from_clipboard":
      return { content: [{ type: "text", text: cb.readSync() }] };

    case "simulate_paste":
      const delay = args.delay_ms || 500;
      execSync(`powershell -Command "Start-Sleep -Milliseconds ${delay}; $wshell = New-Object -ComObject WScript.Shell; $wshell.SendKeys('^v')"`);
      return { content: [{ type: "text", text: "Pasted." }] };
  }
}

module.exports = { definitions, handle };
