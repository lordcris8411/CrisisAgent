# Crisis Agent

Crisis Agent is a powerful, **AI-based** hierarchical agent system designed to bridge high-level natural language intent with low-level system automation. It leverages Large Language Models (LLMs) like Qwen 2.5/3.5 to perform complex technical tasks through a specialized three-tier server architecture.

## 🤖 AI-Powered Core

At its heart, Crisis Agent uses advanced AI reasoning to:
- **Understand Intent**: Parses complex, multi-step instructions from users.
- **Strategic Planning**: Decomposes goals into actionable system commands.
- **Tool Discovery**: Implements a strict "Research-then-Execute" protocol, where agents must research tool capabilities before use to ensure safety and precision.
- **Multimodal Analysis**: Directly processes visual data (images) and files for integrated technical workflows.

## 🏗️ Architecture

Crisis Agent is a distributed server-side suite comprised of several core components:

### 1. Server-Side Components
- **CLI (`cli.js`)**: The "Commander" and Web Server. It manages conversation history, token usage, handles the WebSocket connection for the UI, and delegates high-level tasks to the Executor.
- **Executor Server (`executor_server.js`)**: The "Intelligent Router". It receives tasks from the CLI, selects the appropriate skills, and spawns expert AI instances to execute them.
- **Resource MCP (`mcp_server.js`)**: The "Capability Provider". A robust worker server that interacts directly with the operating system (File I/O, Shell, Automation).
- **Updater Server (`updater_server.js`)**: A maintenance service that receives code payloads and performs self-updates and system reboots.

### 2. Client-Side Tools
- **Web Console**: The primary graphical interface (browser-based) for interacting with the agent.
- **Updater Client (`updater_client.js`)**: A CLI tool used by developers to push updates to remote server nodes.

## 🌐 Web Console Features

The modern, dark-themed Web Console provides a professional cockpit for system management:
- **Real-Time Monitoring**: Live display of system IP, port, uptime, and active AI models.
- **Token Analytics**: Detailed breakdown of Prompt, Response, and Total token consumption.
- **Dynamic Skill Management**: Toggle specific system capabilities (skills) on/off on the fly.
- **Multimodal Interaction**: Drag-and-drop support for images and files with professional visual previews.
- **Advanced File Handling**: High-speed streaming uploads ("Push to Server") and one-click remote file downloads via `Public Download URL`.
- **Execution Visibility**: Live "Chain-of-Thought" (Thinking) display and real-time execution timers for background tasks.

## ⚙️ Configuration (`config.json`)

- **`CLI_LLM`**: LLM host and model for the Commander layer (logic and reasoning).
- **`EXECUTOR_LLM`**: LLM host and model for the Execution layer (task execution).
- **`RESOURCE_MCP_URL`**: The endpoint where the worker node (`mcp_server.js`) resides.
- **`AUTH_TOKEN`**: Secure token for authenticating updates and RPC calls.
- **Ports**: Definitions for `EXECUTOR_PORT` (3001), `UPDATER_PORT` (3003), and MCP (3000).
- **Thinking Toggles**: `CLI_THINK` and `EXECUTOR_THINK` to toggle real-time reasoning display.

## 🚀 Quick Start

1.  **Install**: `npm install`
2.  **Configure**: Edit `config.json` with your LLM settings and remote URLs.
3.  **Start**: `npm start` (Launches the full Server stack).
4.  **Access**: Open `http://localhost:3002` in your browser.
5.  **Maintain**: Use `node updater_client.js` to sync code to remote nodes.

---
*Created by Crisis Agent Team. Built for the future of system automation.*
