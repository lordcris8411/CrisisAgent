# Crisis Agent - Project Overview

Crisis Agent is a hierarchical AI agent system that bridges high-level user intent with low-level system automation. It uses a semantic-driven two-tier architecture: CLI -> System (Executor + MCP).

## Core Architecture

- **CLI (`cli.js`)**: The "Commander" layer.
    - Manages user interaction and conversation history.
    - Uses **Semantic Delegation**: Instead of calling complex system APIs, it delegates tasks using natural language to the Executor via the `delegate_task` tool.
    - Tracks global token usage (Prompt/Response) across all layers.
    - Supports real-time **Thinking (CoT)** display.
    - Hosts a Web UI for remote access to the local machine.
- **Executor Server (`executor_server.js`)**: The "Dispatcher & Expert" layer.
    - **Stage 1 (Dispatcher)**: Uses a lightweight LLM call to route natural language instructions to the most appropriate "Skill" (Function).
    - **Stage 2 (Expert)**: Spawns a specialized LLM agent for the selected skill, granted access only to required low-level tools.
    - Dynamically loads and manages modular skills from the `functions/` directory.
    - Reports internal token usage back to the CLI.
- **Resource MCP (`mcp_server/mcp_server.js`)**: The "Capabilities" layer.
    - A robust RESTful server exposing raw system tools (File I/O, Screen Capture, Desktop Automation) on the local host.
    - Designed for stability: Modular loading prevents crashes even if a tool script has syntax errors.
- **Supervisor (`start.js`)**: The "Process Manager".
    - Orchestrates the startup sequence (MCP Server -> Executor -> CLI).
    - Implements robust **Supervised Rebooting**: Detects exit code `99` from sub-processes to trigger a synchronized system restart.

## Key Features

- **Local System Control**: Deep integration with the host machine via PowerShell and Win32 APIs for file management, process control, and system monitoring.
- **Semantic Routing**: Moves away from rigid API protocols to flexible, intent-based delegation.
- **Hierarchical Thinking**: Supports independent CoT display for both CLI and Executor, providing visibility into the entire decision chain.
- **Modular Skill System**: Skills are defined in `.func` JSON files, including their own system prompts and tool whitelists.
- **Dynamic Skill Management**: Enable or disable skills on the fly without restarting the server.
- **Attachment Awareness**: Seamlessly handles user-uploaded files and images, saving them directly to the system for analysis or storage.

## Available Skills (Built-in)

- **File Operations**: Comprehensive CRUD on the local file system.
- **System Monitoring**: Performance Monitor (CPU/Mem/Disk), Hardware Analyst, Process Manager.
- **Visuals**: Screen Helper (Capture and Analysis) of the host desktop.
- **Automation**: Application Launcher and Script Execution.

## CLI Commands

- `/system`: View the current system prompt and its static token cost.
- `/context`: View conversation history and cumulative token usage.
- `/list skills`: List all available skills and their current [ON/OFF] status.
- `/list mcp functions`: List all low-level atomic tools available on the system.
- `/set skill <name> enabled/disabled`: Dynamically toggle a skill's availability (persisted to disk).
- `/set cli_think on/off`: Toggle thinking display for the CLI layer.
- `/set exec_think on/off`: Toggle thinking display for the Executor layer.
- `/reboot`: Perform a clean, ordered restart of the entire system.
- `/clear`, `/reset`, `/exit`: Standard session management.

## Development Conventions

- **Brace Style**: Strictly follow the **Allman style** (opening braces on a new line).
- **Protocol**: Prefer semantic delegation (`delegate_task`) over expanding the MCP toolset for high-level logic.
- **Stability**: Implement `try-catch` and verification steps for all system-impacting operations.
