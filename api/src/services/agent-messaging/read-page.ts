import { ConflictError } from '../../http/errors.js';

// MCP embeds the response both as structured content and as escaped JSON text.
// Bound the whole page, including its caller-provided metadata, with headroom
// below the wrapper's 2 MiB transport limit.
export function readMessagePage<Row, Message>(
  rows: Row[],
  project: (row: Row) => Message,
  envelope: Record<string, unknown>,
): { messages: Message[]; count: number } {
  const messages: Message[] = [];
  let bytes = Buffer.byteLength(JSON.stringify({ ...envelope, messages }));
  for (const row of rows) {
    const message = project(row);
    const size = Buffer.byteLength(JSON.stringify(message)) + 1;
    // Reserve growth of the final cursor; maximum-sized legal bodies fit alone
    // even when every character needs a six-byte JSON escape.
    if (bytes + size + 32 > 512 * 1024) {
      if (!messages.length)
        throw new ConflictError('Message exceeds response limit', 'agent_messaging_message_too_large');
      break;
    }
    messages.push(message);
    bytes += size;
  }
  return { messages, count: messages.length };
}
