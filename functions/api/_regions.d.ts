export interface RegionStat {
  ok: number;
  total: number;
  p50: number | null;
  p95: number | null;
  fastest: { name: string; latency: number } | null;
  slowest: { name: string; latency: number } | null;
}

export function isNonNodeLine(name: unknown): boolean;
export function parseRegionCode(name: unknown): string | null;
export function regionLabel(code: string | null): string;
export function buildRegionStats(lines: unknown): Record<string, RegionStat>;
export function normalizeSnapshotSummary(summary: unknown, payload: unknown): Record<string, unknown>;
