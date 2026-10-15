import type { ApiKeyEngine, ApiSurfaceId } from "$lib/api/types";

export const KEY_SURFACE: Record<ApiKeyEngine, ApiSurfaceId> = {
  openai: "openai", claude: "anthropic", grok: "grok",
};
export const FORMAT_LABEL: Record<ApiKeyEngine, string> = {
  openai: "OpenAI-compatible", claude: "Anthropic-compatible", grok: "Grok (OpenAI-compatible)",
};
export const BACKEND_LABEL = { codex: "Codex", claude: "Claude", grok: "Grok" } as const;

export function connectionUrls(format: ApiKeyEngine, baseUrl: string) {
  const generation = format === "claude"
    ? [["Messages URL", "/messages"], ["Responses URL", "/responses"], ["Completions URL", "/complete"]]
    : [["Chat completions URL", "/chat/completions"], ["Responses URL", "/responses"], ["Completions URL", "/completions"]];
  return [
    { label: "Base URL", value: baseUrl },
    { label: "Models URL", value: `${baseUrl}/models` },
    ...generation.map(([label, path]) => ({ label: label!, value: `${baseUrl}${path}` })),
  ];
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function curlExample(format: ApiKeyEngine, baseUrl: string, key: string): string {
  const anthropic = format === "claude";
  const payload = {
    model: "MODEL_ID_FROM_MODELS_URL",
    ...(anthropic ? { max_tokens: 256 } : {}),
    messages: [{ role: "user", content: "Hello" }],
  };
  return [
    `curl ${shellQuote(`${baseUrl}${anthropic ? "/messages" : "/chat/completions"}`)}`,
    `  -H ${shellQuote(anthropic ? `x-api-key: ${key}` : `Authorization: Bearer ${key}`)}`,
    ...(anthropic ? ["  -H 'anthropic-version: 2023-06-01'"] : []),
    "  -H 'Content-Type: application/json'",
    `  -d ${shellQuote(JSON.stringify(payload))}`,
  ].join(" \\\n");
}
