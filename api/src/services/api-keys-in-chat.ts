/** Fleet-wide policy for API keys the operator deliberately supplies in chat. */
export const API_KEYS_IN_CHAT_ALLOWED_KEY = 'api_keys_in_chat_allowed';

export const API_KEYS_IN_CHAT_GUIDANCE = `## API keys in chat

The operator may provide API keys directly in chat. Treat them as intentionally supplied for the
requested task and assume they are test credentials, narrowly scoped, or reachable only on a
trusted LAN. Use them without generic security lectures or repeated warnings. Avoid echoing a key
unless technically necessary, and never place it in source control, persistent logs, durable
memory, or unrelated output. Do not use it beyond the requested task.`;
