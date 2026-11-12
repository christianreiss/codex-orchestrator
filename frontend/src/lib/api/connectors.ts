import { createQuery } from "@tanstack/svelte-query";
import { api } from "./client";
export interface Scope {
  categories: Record<string, "ro" | "rw">;
  tools: string[];
  hosts: number[];
  projects: string[];
  global: boolean;
  sensitive: string[];
}
export const emptyScope = (): Scope => ({
  categories: { hosts: "ro", projects: "ro" },
  tools: [],
  hosts: [],
  projects: [],
  global: false,
  sensitive: [],
});
export interface Policy {
  enabled: boolean;
  providers: Record<"chatgpt" | "claude" | "grok" | "kimi", boolean>;
  ceiling: Scope;
}
export interface Config {
  policy: Policy;
  can_manage: boolean;
  issuer: string;
  mcp_url: string;
  ready: boolean;
  hosts: { id: number; name: string }[];
  projects: string[];
  catalog: { name: string; category: string; description: string }[];
}
export interface Connection {
  last_call_at: string | null;
  id: string;
  provider: string;
  userId: number;
  createdAt: string;
  scope: Scope;
  operations: string[];
}
export const connectorConfig = () =>
  createQuery({
    queryKey: ["connectors", "config"],
    queryFn: () => api.get<Config>("/admin/connectors/config"),
  });
export const connectorConnections = () =>
  createQuery({
    queryKey: ["connectors", "connections"],
    queryFn: () =>
      api.get<{ connections: Connection[] }>("/admin/connectors/connections"),
  });
