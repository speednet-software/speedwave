# Architecture Overview

Speedwave is an orchestration layer that manages containers, MCP servers, and IDE integration — all bundled into a single installable application.

## System Diagram

```mermaid
graph TD
    subgraph Host
        APP[Speedwave.app / Tauri]
        MCP_OS[mcp-os worker]
        IDE[IDE Bridge]
        CLI[speedwave CLI]
    end

    subgraph "Lima VM / WSL2 / Native"
        CLAUDE[Claude container]
        HUB[MCP Hub container]
        WORKERS[MCP service containers]
    end

    APP --> MCP_OS
    APP --> IDE
    APP --> |manages| CLAUDE
    CLI --> |starts| CLAUDE
    CLAUDE --> HUB
    HUB --> WORKERS
    HUB --> |HTTP bridge| MCP_OS
    CLAUDE --> |WebSocket| IDE
```

## Components

<!-- Content to be written: detailed component descriptions, data flow, communication protocols -->

## Key Design Decisions

See [ADR Index](../adr/README.md) for all architectural decisions.

## See Also

- [Security Model](security.md)
- [Containers](containers.md)
- [Platform Matrix](platform-matrix.md)
- [Bundled Resources](bundled-resources.md) — what Speedwave injects into the Claude container
