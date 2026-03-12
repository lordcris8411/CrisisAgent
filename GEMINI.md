# Crisis Agent - Project Overview

Crisis Agent is a hierarchical AI agent system that bridges high-level user intent with low-level system automation. It uses a semantic-driven two-tier architecture: CLI -> System (Executor + MCP).

## Core Architecture

- **CLI (`cli.js`)**: The "Commander" layer.
    - Manages user interaction, conversation history, and high-level delegation.
    - **Log Aggregator**: Collects and displays real-time logs from all system components.
    - **Attachment Host**: Handles complex file uploads (Base64 and binary streaming) and manages the `uploads/` directory.
    - **Web UI**: Hosts a WebSocket-enabled dashboard for remote access, real-time log streaming, and attachment management.
- **Executor Server (`executor_server.js`)**: The "Dispatcher & Execution" layer.
    - **Stage 1 (Planner)**: Analyzes the task, selects the best "Skill", and generates a multi-step execution plan in JSON.
    - **Stage 2 (Execute_Loop)**: Iteratively executes each step of the plan by spawning specialized LLM expert calls and managing tool orchestration.
    - **Stage 3 (Reporter)**: Consolidates the execution trace into a final, comprehensive Markdown report for the user.
    - **Discovery Protocol**: Enforces tool safety by requiring experts to "unlock" tool schemas via `get_tool_usage`.
- **Resource MCP (`mcp_server/mcp_server.js`)**: The "Capabilities" layer.
    - A robust RESTful server exposing raw system tools (File I/O, Screen Capture, Desktop Automation).
    - **Protocol-Enforced Safety**: Implements a strict "Look Before You Leap" policy where tools are locked by default until a schema discovery call is made.
- **Updater Server (`updater_server.js`)**: The "Maintenance" layer.
    - Manages remote file updates and triggers synchronized system reboots across all layers.
- **Supervisor (`start.js`)**: The "Process Manager".
    - Orchestrates the startup sequence (Updater -> MCP -> Executor -> CLI).
    - Implements **Supervised Rebooting**: Detects exit code `99` from sub-processes to trigger an ordered system-wide restart.

## Key Features

- **Protocol-Enforced Safety**: Tools are locked by default. The Executor MUST call `get_tool_usage` to retrieve the schema and safety constraints before execution, ensuring the LLM operates with accurate, up-to-date context.
- **Real-Time Log Streaming**: Integrated Web UI provides a live feed of the entire system's internal thinking (CoT) and execution logs via WebSockets.
- **Attachment Awareness**: Supports multi-modal workflows with Base64 and streaming support for large files and images, automatically shared between CLI and Executor.
- **Local System Control**: Deep integration with the host machine via PowerShell and Win32 APIs for file management, process control, and system monitoring.
- **Hierarchical Thinking**: Supports independent CoT display for both CLI and Executor layers, providing visibility into the entire decision chain.
- **Modular Skill System**: Skills are defined in `.func` JSON files, including their own system prompts, tool whitelists, and dependency checks.

## Available Skills (Built-in)

- **Coder**: Senior engineer for writing, debugging, and explaining source code across languages.
- **File Manager**: Comprehensive CRUD and management of the local file system.
- **File Searcher**: Wildcard-based recursive system-wide file discovery.
- **App Launcher**: Application execution and GUI automation.
- **Downloader**: Web resource retrieval and file downloads.
- **Env Analyst**: Environment context and system introspection.
- **Hardware Analyst**: Performance monitoring and hardware diagnostics.
- **Process Manager**: System process oversight and resource management.
- **Screen Reader**: Visual capture and desktop analysis.
- **Time Teller**: Temporal awareness and timezone-aware clock queries.
- **Visual Analyst**: Specialized analysis of session-uploaded images.

## CLI Commands

### Session Management
- `/help`: Display the comprehensive help menu.
- `/clear`: Clear the terminal screen.
- `/reset`: Reset the current conversation history and token counters.
- `/reboot`: Perform a clean, ordered restart of the entire system.
- `/exit`: Terminate the application.

### Debugging & Monitoring
- `/context`: View detailed conversation history and cumulative token usage.
- `/system`: View the CLI-side system prompt and its current token cost.
- `/exe_system`: View the Executor-side system prompt template and cached environment context.
- `/skill_debug`: Diagnose skill health and check for missing MCP tool dependencies.

### System & Skill Control
- `/list skills`: List all available skills and their current [ON/OFF] status.
- `/list mcp functions`: List all low-level atomic tools available on the system.
- `/set skill <name> <on/off>`: Dynamically toggle a skill's availability.
- `/set cli_think <on/off>`: Toggle thinking (CoT) display for the CLI layer.
- `/set exec_think <on/off>`: Toggle thinking (CoT) display for the Executor layer.

## Development Conventions

- **Brace Style**: Strictly follow the **Allman style** (opening braces on a new line).
- **Protocol**: Prefer semantic delegation (`delegate_task`) over expanding the MCP toolset for high-level logic.
- **Discovery**: Always use `get_tool_usage` before executing any MCP tool to ensure safety and schema compliance.
- **Stability**: Implement robust `try-catch` blocks and verification steps for all system-impacting operations.
