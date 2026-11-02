import { describe, expect, it, vi } from 'vitest';
import { createWorkflowCollaboration } from '../../src/services/agent-messaging/workflows.js';
import type { AgentMessagingService } from '../../src/services/agent-messaging.js';
import type { WorkflowTx } from '../../src/services/workflows/contract.js';

for (const engine of ['codex', 'claude', 'grok']) describe(`${engine} workflow start message`, () => {
  function fixture() {
    const session = {id:'session',hostId:1,engine,bindingGeneration:3,adapterCapabilities:{workflow_protocol_version:2}};
    const address = {id:'address',hostId:1,engine,bindingGeneration:3};
    const bus = {workflowTarget:vi.fn().mockResolvedValue({session,address}),coordinationNotice:vi.fn().mockResolvedValue('message')};
    const adapter = createWorkflowCollaboration(bus as unknown as AgentMessagingService,'https://fleet.example');
    const input = {actor:{kind:'admin' as const,id:'operator'},target:{kind:'agent' as const,id:'address',address_id:'address',session_id:'session',binding_generation:3},run_id:'run',summary_revision:7,coordinator_generation:2};
    return {bus,adapter,input,session};
  }
  it('addresses the exact binding with a stable receipt and current-state verification instructions', async () => {
    const {bus,adapter,input} = fixture();
    await expect(adapter.notifyStart!({} as WorkflowTx,input)).resolves.toEqual({message_id:'message'});
    await adapter.notifyStart!({} as WorkflowTx,input);
    expect(bus.coordinationNotice.mock.calls[0]![2]).toContain('WORKFLOW-START/1 run_id=run summary_revision=7 coordinator_generation=2');
    expect(bus.coordinationNotice.mock.calls[0]![2]).toContain('verify that this summary revision is still confirmed');
    expect(bus.coordinationNotice.mock.calls[0]![3]).toBe(true);
    expect(bus.coordinationNotice.mock.calls[1]![4]).toEqual(bus.coordinationNotice.mock.calls[0]![4]);
    await adapter.notifyStart!({} as WorkflowTx,{...input,summary_revision:8});
    expect(bus.coordinationNotice.mock.calls[2]![4]).not.toEqual(bus.coordinationNotice.mock.calls[0]![4]);
  });
  it('rejects stale bindings, unavailable receivers and old workflow protocols', async () => {
    const {bus,adapter,input,session} = fixture();
    await expect(adapter.notifyStart!({} as WorkflowTx,{...input,target:{...input.target,session_id:'old'}})).rejects.toMatchObject({code:'workflow_binding_changed'});
    expect(bus.coordinationNotice).not.toHaveBeenCalled();
    bus.coordinationNotice.mockResolvedValue(undefined);
    await expect(adapter.notifyStart!({} as WorkflowTx,input)).rejects.toMatchObject({code:'workflow_target_unavailable'});
    session.adapterCapabilities.workflow_protocol_version = 1;
    await expect(adapter.notifyStart!({} as WorkflowTx,input)).rejects.toMatchObject({code:'workflow_wrapper_outdated'});
  });
});
