export interface ProjectEventMetadata {
  id: number;
  projectId: number;
  seq: number;
  eventType: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  payloadJson: Record<string, unknown> | null;
  sourceHostId: number | null;
  createdAt: string;
}
export function projectEventMetadata(event: ProjectEventMetadata): ProjectEventMetadata {
  const payload = event.payloadJson ? structuredClone(event.payloadJson) : null;
  if (payload && Buffer.byteLength(JSON.stringify(payload)) > 8192)
    return { ...event, payloadJson: { _owner_payload_omitted: true } };
  if (payload)
    for (const key of ['body', 'detail', 'content'])
      if (typeof payload[key] === 'string') {
        const text = payload[key] as string;
        payload[key] = text.slice(0, 280);
        payload[key + '_length'] = Math.max(
          typeof payload[key + '_length'] === 'number' ? (payload[key + '_length'] as number) : 0,
          text.length,
        );
        payload[key + '_truncated'] = payload[key + '_truncated'] === true || text.length > 280;
      }
  return {
    ...event,
    payloadJson:
      payload && Buffer.byteLength(JSON.stringify(payload)) > 16384
        ? { _owner_payload_omitted: true }
        : payload,
  };
}
export function boundedProjectEvents(events: readonly ProjectEventMetadata[]): ProjectEventMetadata[] {
  const sorted = [...events].sort((a, b) => b.seq - a.seq),
    keep = new Set(
      [
        ...sorted.slice(0, 20),
        ...sorted.filter((e) => e.entityType === 'card' && e.action === 'claim_expired').slice(0, 10),
      ].map((e) => e.id),
    );
  return sorted.filter((e) => keep.has(e.id)).map(projectEventMetadata);
}
