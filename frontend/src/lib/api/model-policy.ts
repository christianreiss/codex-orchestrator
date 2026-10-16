import { derived, readable, type Readable } from 'svelte/store';
import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
import { api, apiFetch } from './client';
import type { Engine } from '$lib/constants/engines';
export interface ModelPolicy {
  engine: Engine;
  latest_only: boolean;
  latest_models: string[];
  replacements: Record<string, string>;
}
export function modelPolicyQuery(engine: Engine | null | Readable<Engine | null>) {
  const source = typeof engine === 'object' && engine !== null ? engine : readable(engine);
  return createQuery<ModelPolicy>(derived(source, engine => ({
    queryKey: ['settings', 'model-policy', engine],
    queryFn: () => api.get<ModelPolicy>(`/admin/model-policy/${engine}`),
    enabled: engine !== null,
  })));
}
export function modelPolicyMutation(engine: Engine) {
  const qc = useQueryClient();
  return createMutation<ModelPolicy, Error, boolean>({
    mutationFn: latest_only => apiFetch<ModelPolicy>(`/admin/model-policy/${engine}`, { method: 'PUT', body: { latest_only } }),
    onSuccess: data => {
      qc.setQueryData(['settings', 'model-policy', engine], data);
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });
}
