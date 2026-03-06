# Crisis Agent - Project Overview

Crisis Agent is a hierarchical AI agent system that bridges high-level user intent with low-level system automation. It uses a semantic-driven three-tier architecture: CLI -> Executor -> Resource MCP.

## Core Architecture

- **CLI (`cli.js`)**: The "Commander" layer.
    - Manages user interaction and conversation history.
    - Uses **Semantic Delegation**: Instead of calling complex system APIs, it delegates tasks using natural language to the Executor via the `delegate_task` tool.
    - Tracks global token usage (Prompt/Response) across all layers.
    - Supports real-time **Thinking (CoT)** display.
- **Executor Server (`executor_server.js`)**: The "Dispatcher & Expert" layer.
    - **Stage 1 (Dispatcher)**: Uses a lightweight LLM call to route natural language instructions to the most appropriate "Skill" (Function).
    - **Stage 2 (Expert)**: Spawns a specialized LLM agent for the selected skill, granted access only to required low-level tools.
    - Dynamically loads and manages modular skills from the `functions/` directory.
    - Reports internal token usage back to the CLI.
- **Resource MCP (`mcp_server.js`)**: The "Capabilities" layer.
    - A robust RESTful server exposing raw system tools (File I/O, Screen Capture, Desktop Automation, SSH).
    - Designed for stability: Modular loading prevents crashes even if a tool script has syntax errors.
- **Supervisor (`start.js`)**: The "Process Manager".
    - Orchestrates the startup sequence (Executor then CLI).
    - Implements robust **Supervised Rebooting**: Detects exit code `99` from sub-processes to trigger a synchronized system restart.

## Key Features

- **Semantic Routing**: Moves away from rigid API protocols to flexible, intent-based delegation.
- **Hierarchical Thinking**: Supports independent CoT display for both CLI and Executor, providing visibility into the entire decision chain.
- **Modular Skill System**: Skills are defined in `.func` JSON files, including their own system prompts and tool whitelists.
- **Dynamic Skill Management**: Enable or disable skills on the fly without restarting the server.
- **Cross-Platform Automation**: Deep integration with Windows via PowerShell and Win32 APIs for mouse, keyboard, and system monitoring.
- **Remote SSH Mastery**: Built-in skills to connect, manage, and execute commands on remote Linux/Unix servers.

## Available Skills (Built-in)

- **File Operations**: Reader, Creator, Modifier, Deleter, Lister (all with automated verification).
- **System Monitoring**: Performance Monitor (CPU/Mem/Disk), Hardware Analyst, Process Manager.
- **Visuals**: Screen Helper (Capture and Analysis).
- **Communication**: SSH Suite (Connect, Disconnect, Execute, Status).
- **Maintenance**: MCP Updater (Native code synchronization between local and remote).

## CLI Commands

- `/system`: View the current system prompt and its static token cost.
- `/context`: View conversation history and cumulative token usage.
- `/list skills`: List all available skills and their current [ON/OFF] status.
- `/list mcp functions`: List all low-level atomic tools available on the Resource MCP.
- `/set skill <name> enabled/disabled`: Dynamically toggle a skill's availability (persisted to disk).
- `/set cli_think on/off`: Toggle thinking display for the CLI layer.
- `/set exec_think on/off`: Toggle thinking display for the Executor layer.
- `/update_mcp`: Trigger the native code synchronization skill.
- `/reboot`: Perform a clean, ordered restart of the entire system.
- `/clear`, `/reset`, `/exit`: Standard session management.

## Development Conventions

- **Brace Style**: Strictly follow the **Allman style** (opening braces on a new line).
- **Protocol**: Prefer semantic delegation (`delegate_task`) over expanding the MCP toolset for high-level logic.
- **Stability**: Implement `try-catch` and verification steps for all system-impacting operations.
