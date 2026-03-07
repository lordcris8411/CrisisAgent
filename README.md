# Crisis Agent

Crisis Agent is a powerful, **AI-based** hierarchical agent system designed to bridge high-level natural language intent with low-level system automation. It leverages Large Language Models (LLMs) like Qwen 2.5/3.5 to perform complex technical tasks through a specialized three-tier architecture.

## 🤖 AI-Powered Core

At its heart, Crisis Agent uses advanced AI reasoning to:
- **Understand Intent**: Parses complex, multi-step instructions from users.
- **Strategic Planning**: Decomposes goals into actionable system commands.
- **Tool Discovery**: Implements a strict "Research-then-Execute" protocol, where agents must research tool capabilities before use to ensure safety and precision.
- **Multimodal Analysis**: Directly processes visual data (images) and files for integrated technical workflows.

## 🏗️ Architecture

Crisis Agent operates using a distributed **Master-Node** (Client-Server) model:

### 1. Control Center (Client Side)
- **CLI (`cli.js`)**: The "Commander". Manages user sessions, maintains conversation history, and provides the Web Console.
- **Updater Client (`updater_client.js`)**: Orchestrates code synchronization. It can push updates to multiple remote servers, supporting scoped updates (Full, Prompt-only, or Web-only).

### 2. Execution Node (Server Side)
- **Executor Server (`executor_server.js`)**: The "Intelligent Router". Receives tasks from the CLI, selects appropriate skills, and spawns expert AI instances to execute them.
- **Resource MCP (`mcp_server.js`)**: The "Capability Provider". A robust worker server that interacts directly with the operating system (File I/O, Shell, Automation).
- **Updater Server (`updater_server.js`)**: Receives code payloads from the client and performs self-updates and system reboots.

## ⚙️ Configuration (`config.json`)

The system's behavior is governed by `config.json`. Key fields include:
- **`CLI_LLM`**: LLM host and model for the Commander layer (logic and reasoning).
- **`EXECUTOR_LLM`**: LLM host and model for the Execution layer (task execution).
- **`RESOURCE_MCP_URL`**: The endpoint where the worker node resides.
- **`AUTH_TOKEN`**: Secure token for authenticating updates and RPC calls.
- **Ports**: Definitions for `EXECUTOR_PORT` (3001), `UPDATER_PORT` (3003), and MCP (3000).
- **Thinking Toggles**: `CLI_THINK` and `EXECUTOR_THINK` to enable/disable real-time Chain-of-Thought display.

## ✨ Key Features

- **Semantic Delegation**: Flexible, intent-based task handover between agent layers.
- **Streaming Uploads**: High-performance binary streaming for large file transfers.
- **Remote Mastery**: Integrated download capabilities for remote files via `Public Download URL`.
- **Modern Web Console**: A sleek dark-themed UI with real-time status monitoring.

## 🚀 Quick Start

1.  **Install**: `npm install`
2.  **Configure**: Edit `config.json` with your LLM settings and remote URLs.
3.  **Start**: `npm start` (Launches the full stack).
4.  **Update**: Use `node updater_client.js` to sync code to your remote nodes.

---
*Created by Crisis Agent Team. Built for the future of system automation.*
