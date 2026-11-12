/** Portal ring metadata. Portal commands have no per-message expiry; claiming owns the body. */
export function portalMailboxEntry(messageId: string, adminId: number, name: string) {
  return {
    source: 'portal',
    message_id: messageId,
    kind: 'portal',
    from: { address: `admin:${adminId}`, alias: name, engine: 'operator', fqdn: null },
    expires_at: null,
  };
}
