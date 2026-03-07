# Crisis Agent

Crisis Agent is a powerful, **AI-based** hierarchical agent system designed to bridge high-level natural language intent with low-level system automation. It leverages Large Language Models (LLMs) like Qwen 2.5/3.5 to perform complex technical tasks through a specialized three-tier architecture.

## 🤖 AI-Powered Core

At its heart, Crisis Agent uses advanced AI reasoning to:
- **Understand Intent**: Parses complex, multi-step instructions from users.
- **Strategic Planning**: Decomposes goals into actionable system commands.
- **Tool Discovery**: Implements a strict "Research-then-Execute" protocol, where agents must research tool capabilities before use to ensure safety and precision.
- **Multimodal Analysis**: Directly processes visual data (images) and files for integrated technical workflows.

## 🏗️ Architecture

1.  **CLI (Commander)**: The primary user interface. Manages conversation history, token usage, and delegates high-level tasks to the Executor.
2.  **Executor (Dispatcher & Expert)**: An intelligent routing layer that selects the best "Skill" for a task and spawns specialized AI agents to execute them.
3.  **Resource MCP (Capabilities)**: A robust server providing atomic system tools such as File I/O, Screen Capture, Desktop Automation, and SSH connectivity.

## ✨ Key Features

- **Semantic Delegation**: Flexible, intent-based task handover between agent layers.
- **Streaming Uploads**: High-performance binary streaming for large file transfers.
- **Remote Mastery**: Built-in capabilities for managing remote systems via SSH.
- **Modern Web Console**: A sleek, professional dark-themed UI with real-time status monitoring and professional asset visualization.
- **Secure by Design**: Strict tool locking mechanisms and local-first execution.

## 🛠️ Requirements

- Node.js 18+
- Ollama (running Qwen or similar compatible models)
- Windows (for full automation features)

## 🚀 Quick Start

1. Install dependencies: `npm install`
2. Configure `config.json` with your LLM endpoints.
3. Start the system: `npm start`

---
*Created by Crisis Agent Team. Built for the future of system automation.*
