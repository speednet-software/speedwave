/** Connection status of the IDE bridge WebSocket proxy. */
export interface BridgeStatus {
  port: number;
  upstream_ide: string | null;
  upstream_port: number | null;
}

/** Health status of a single project container. */
export interface ContainerHealth {
  name: string;
  status: string;
  healthy: boolean;
}

/** Health status of the Lima/WSL2 virtual machine. */
export interface VmHealth {
  running: boolean;
  vm_type: string;
}

/** Health status of the mcp-os host worker process. */
export interface McpOsHealth {
  running: boolean;
}

/** An IDE instance detected on the host for bridge proxying. */
export interface DetectedIde {
  ide_name: string;
  port: number | null;
  ws_url: string | null;
}

/** Health status of the IDE bridge including detected upstream IDEs. */
export interface IdeBridgeHealth {
  running: boolean;
  port: number | null;
  ws_url: string | null;
  detected_ides: DetectedIde[];
}

/** Aggregated system health report across all Speedwave subsystems. */
export interface HealthReport {
  containers: ContainerHealth[];
  vm: VmHealth;
  mcp_os: McpOsHealth;
  ide_bridge: IdeBridgeHealth;
  overall_healthy: boolean;
}
