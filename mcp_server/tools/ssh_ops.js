const { NodeSSH } = require('node-ssh');

let sshInstance = null;
let currentConnectionInfo = null;

const definitions = [
  {
    name: "ssh_connect",
    description: "Connect to a remote server via SSH.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        port: { type: "integer", default: 22 }
      },
      required: ["host", "username", "password"]
    }
  },
  {
    name: "ssh_disconnect",
    description: "Disconnect from the current SSH session.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "ssh_execute",
    description: "Execute a command on the remote SSH server.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" }
      },
      required: ["command"]
    }
  },
  {
    name: "ssh_get_status",
    description: "Check if an SSH session is currently active.",
    inputSchema: { type: "object", properties: {} }
  }
];

async function handle(name, args)
{
  switch (name)
  {
    case "ssh_connect":
      try
      {
        if (sshInstance)
        {
          sshInstance.dispose();
        }
        sshInstance = new NodeSSH();
        await sshInstance.connect({
          host: args.host,
          username: args.username,
          password: args.password,
          port: args.port || 22
        });
        currentConnectionInfo = { host: args.host, username: args.username };
        return { content: [{ type: "text", text: `Successfully connected to ${args.username}@${args.host}` }] };
      }
      catch (error)
      {
        sshInstance = null;
        currentConnectionInfo = null;
        return { isError: true, content: [{ type: "text", text: `SSH Connection Error: ${error.message}` }] };
      }

    case "ssh_disconnect":
      if (sshInstance)
      {
        sshInstance.dispose();
        sshInstance = null;
        currentConnectionInfo = null;
        return { content: [{ type: "text", text: "SSH session closed." }] };
      }
      return { content: [{ type: "text", text: "No active SSH session to close." }] };

    case "ssh_execute":
      if (!sshInstance)
      {
        return { isError: true, content: [{ type: "text", text: "No active SSH session. Please connect first." }] };
      }
      try
      {
        const result = await sshInstance.execCommand(args.command);
        let output = "";
        if (result.stdout) output += result.stdout;
        if (result.stderr) output += (output ? "\n" : "") + "STDERR: " + result.stderr;
        if (!output) output = "(No output)";
        return { content: [{ type: "text", text: output }] };
      }
      catch (error)
      {
        return { isError: true, content: [{ type: "text", text: `SSH Execution Error: ${error.message}` }] };
      }

    case "ssh_get_status":
      if (sshInstance && sshInstance.connection)
      {
        return { content: [{ type: "text", text: `Connected to ${currentConnectionInfo.username}@${currentConnectionInfo.host}` }] };
      }
      return { content: [{ type: "text", text: "Disconnected" }] };

    default:
      throw new Error(`Unknown SSH tool: ${name}`);
  }
}

module.exports = { definitions, handle };
