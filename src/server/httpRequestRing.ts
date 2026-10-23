export type HttpAccessLogEntry = {
  ts: string;
  method: string;
  pathname: string;
  /** 推理通道：yueliai / openai / kgm 等 */
  channel?: string;
  subpath?: string;
  status?: number;
  traceId?: string;
  requestId?: string;
};

const MAX = 500;
const ring: HttpAccessLogEntry[] = [];

export function appendHttpAccessLog(entry: HttpAccessLogEntry): void {
  ring.push(entry);
  if (ring.length > MAX) {
    ring.splice(0, ring.length - MAX);
  }
}

export function snapshotHttpAccessLog(limit: number, traceId?: string): HttpAccessLogEntry[] {
  const n = Math.max(1, Math.min(limit, MAX));
  const entries = traceId ? ring.filter((entry) => entry.traceId === traceId) : ring;
  return entries.slice(-n);
}
