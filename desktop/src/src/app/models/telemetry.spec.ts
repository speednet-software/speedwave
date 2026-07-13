import { describe, it, expect } from 'vitest';
import type { TelemetryConfigResponse, OtlpProtocol } from './telemetry';

describe('TelemetryConfigResponse locks', () => {
  it('reads a per-field lock by semantic name (no OTEL keys on the frontend)', () => {
    const resp = {
      locks: { endpoint: true, headers: false },
    } as unknown as TelemetryConfigResponse;
    expect(resp.locks.endpoint).toBe(true);
    expect(resp.locks.headers).toBe(false);
  });

  it('OtlpProtocol union carries the three OTLP wire strings', () => {
    const all: OtlpProtocol[] = ['grpc', 'http/protobuf', 'http/json'];
    expect(all).toHaveLength(3);
  });
});
