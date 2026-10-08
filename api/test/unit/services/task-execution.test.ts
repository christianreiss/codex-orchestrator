import { describe, it, expect } from 'vitest';
import { taskResultSchema } from '../../../src/services/agent-messaging/task-execution.js';
import { recoveryDelaySeconds } from '../../../src/services/schedules/recovery.js';
describe('explicit work outcomes and recovery cadence', () => {
 it('rejects guessed outcomes, oversized UTF-8 bodies and open result schemas', () => {
  expect(taskResultSchema.safeParse({status:'ok',summary:'done'}).success).toBe(false);
  expect(taskResultSchema.safeParse({status:'succeeded',summary:'🙂'.repeat(1100)}).success).toBe(false);
  expect(taskResultSchema.safeParse({status:'failed',summary:'failed',exit_code:0}).success).toBe(false);
  expect(taskResultSchema.safeParse({status:'blocked',summary:'need input',evidence:[{description:'source',reference:'/tmp/source',secret:'x'}]}).success).toBe(false);
 });
 it('accepts explicit outcomes with bounded evidence, without changing their status', () => {
  for(const status of ['succeeded','failed','blocked','unknown']) expect(taskResultSchema.parse({status,summary:'actual outcome',evidence:[{description:'test',reference:'npm test'}]}).status).toBe(status);
 });
 it('doubles failures, caps at one hour or base cadence, and adds only positive jitter', () => {
  expect(recoveryDelaySeconds(60,0,()=>0)).toBe(60);
  expect(recoveryDelaySeconds(60,1,()=>0)).toBe(120);
  expect(recoveryDelaySeconds(60,20,()=>0)).toBe(3600);
  expect(recoveryDelaySeconds(7200,20,()=>1)).toBe(8640);
  expect(recoveryDelaySeconds(60,0,()=>1)).toBe(72);
 });
});
