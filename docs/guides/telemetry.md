# Telemetry (OTLP)

Speedwave can send the in-container Claude Code's OpenTelemetry (OTLP) telemetry to a collector you choose. A user configures it in **Settings → Telemetry**; an organization can force or lock the settings via an MDM-deployed file so the user cannot change them.

## User self-service

In **Settings → Telemetry**:

1. Turn on the **Send telemetry** toggle ("Send Speedwave usage telemetry to your own OpenTelemetry (OTLP) collector.").
2. Set the **collector endpoint** (e.g. `https://collector.example.com:4318`) and **protocol** (gRPC / HTTP-protobuf / HTTP-JSON).
3. Optionally set **auth headers** (e.g. `Authorization=Bearer <token>`). The value is masked and stays on your machine.
4. Use **Test connection** to check the collector is reachable from this host.

The **Privacy (advanced)** group controls whether conversation and code content is included. All four gates are off by default and turning one on requires an explicit confirmation, because it sends the content of your prompts, the assistant's responses, tool details, or raw API bodies to the collector.

## Organization enforcement (MDM)

> **Claude Team / Enterprise admins:** a telemetry policy set in the Claude console (Admin Settings > Claude Code > Managed settings) does **not** reach Claude Code inside Speedwave. Claude Code runs behind Speedwave's local proxy (`ANTHROPIC_BASE_URL` is non-default), and Anthropic's server-managed settings are bypassed for any non-default base URL. Enforce telemetry through Speedwave's own `managed-config.json` below instead.

An administrator can force any subset of the telemetry settings by deploying a `managed-config.json` to a machine-wide, admin-only location:

- macOS: `/Library/Application Support/Speedwave/managed-config.json`
- Windows: `%ProgramData%\Speedwave\managed-config.json`

**Presence is the lock:** any field the file sets becomes read-only for the user (shown as "managed by your organization"). Omit a field to leave it user-editable. A malformed file is a hard error, so Speedwave fails closed rather than silently ignoring the policy.

The policy is validated once, at startup. An invalid `managed-config.json` (bad JSON, an unknown key, or `enabled: true` without a valid endpoint) blocks Speedwave from starting: the app shows a native "Organization policy error" dialog (the CLI prints the error and exits non-zero) and does not open until an administrator corrects the file. A bad push therefore blocks every user on that machine, so validate the file before deploying it.

### Example: force a corporate collector, disable content logging

```json
{
  "telemetry": {
    "enabled": true,
    "endpoint": "https://otel.corp.example.com:4318",
    "protocol": "http/protobuf",
    "export_metrics": true,
    "export_logs": true,
    "headers": "Authorization=Bearer corp-collector-token",
    "log_user_prompts": false,
    "log_assistant_responses": false,
    "log_tool_details": false,
    "log_raw_api_bodies": false
  }
}
```

### Example: kill-switch (no telemetry, and the user can't turn it on)

```json
{
  "telemetry": {
    "enabled": false
  }
}
```

With the kill-switch the whole Telemetry section collapses to a locked banner (`data-testid="telemetry-killswitch"`) reading "Managed by your organization — telemetry cannot be changed here." No editable controls are shown.

### Fields

Every field is optional; omit it to leave it user-editable.

| Field                                                                                      | Meaning                                    |
| ------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `enabled`                                                                                  | Master switch. `false` is the kill-switch. |
| `endpoint`                                                                                 | OTLP collector URL.                        |
| `protocol`                                                                                 | `grpc` \| `http/protobuf` \| `http/json`.  |
| `export_metrics` / `export_logs`                                                           | Which signals to export.                   |
| `headers`                                                                                  | Collector auth headers (`Key=Value,…`).    |
| `resource_attributes`                                                                      | Custom attributes (`key=value,…`).         |
| `include_account_uuid`                                                                     | Include the account UUID in metrics.       |
| `log_user_prompts` / `log_assistant_responses` / `log_tool_details` / `log_raw_api_bodies` | Content privacy gates (default off).       |
| `metric_export_interval_ms` / `logs_export_interval_ms`                                    | Export intervals in milliseconds.          |

Design and enforcement details: [ADR-076](../adr/ADR-076-mdm-enforceable-otlp-telemetry.md).
