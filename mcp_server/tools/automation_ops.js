const { execSync } = require('child_process');

const definitions = 
[
  { 
    name: "mouse_move", 
    description: "Move the mouse cursor to specific screen coordinates.", 
    inputSchema: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" } }, required: ["x", "y"] } 
  },
  { 
    name: "mouse_click", 
    description: "Perform a mouse click at current position. button: 'left' or 'right'.", 
    inputSchema: { type: "object", properties: { button: { type: "string", enum: ["left", "right"], default: "left" } } } 
  }
];

async function handle(name, args)
{
  try
  {
    switch (name)
    {
      case "mouse_move":
      {
        const psCommand = `$null = [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${args.x}, ${args.y})`;
        execSync(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ${psCommand}"`);
        return { content: [{ type: "text", text: `Moved to ${args.x}, ${args.y}` }] };
      }

      case "mouse_click":
      {
        const isRight = args.button === 'right';
        const downEvent = isRight ? 0x0008 : 0x0002;
        const upEvent = isRight ? 0x0010 : 0x0004;
        const psClick = `
          $def = '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);';
          $type = Add-Type -MemberDefinition $def -Name "Win32Mouse" -Namespace "Win32" -PassThru;
          $type::mouse_event(${downEvent}, 0, 0, 0, 0);
          $type::mouse_event(${upEvent}, 0, 0, 0, 0);
        `;
        execSync(`powershell -Command "${psClick}"`);
        return { content: [{ type: "text", text: `Performed ${args.button} click` }] };
      }
    }
  }
  catch (e)
  {
    return { isError: true, content: [{ type: "text", text: `Automation Error: ${e.message}` }] };
  }
}

module.exports = { definitions, handle };
