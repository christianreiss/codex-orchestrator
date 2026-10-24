import { describe, expect, it, vi } from 'vitest';
import { startWrapperPublishWatch } from '../../../src/services/wrapper-publish-watch.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import type { WrapperBinRegistry } from '../../../src/services/wrapper-bin-registry.js';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
vi.mock('node:fs', async (original) => {
  const module = await original<typeof import('node:fs')>();
  return { ...module, watch: vi.fn(module.watch) };
});

describe('wrapper publish watch', () => {
  it('never recursively watches a missing tree ancestor and attaches to the created target', async () => {
    const root=fs.mkdtempSync(join(tmpdir(),'bounded-wrapper-watch-')),target=join(root,'missing','bin');
    const callbacks:Array<(event:string,name:string)=>void>=[],closed=vi.fn();
    const watcher={close:closed,on:vi.fn()} as unknown as fs.FSWatcher;
    const mock=vi.mocked(fs.watch);
    mock.mockImplementation(((_path:unknown,_options:unknown,callback:unknown)=>{callbacks.push(callback as (event:string,name:string)=>void);return watcher;}) as typeof fs.watch);
    const registry={invalidate(){},async manifestForPlatform(){return null;}} as unknown as WrapperBinRegistry;
    let stop=()=>{};
    try {
      stop=startWrapperPublishWatch(registry,{binRoot:target,error(error){throw error;}});
      expect(mock).toHaveBeenLastCalledWith(root,{recursive:false,persistent:false},expect.any(Function));
      fs.mkdirSync(target,{recursive:true});callbacks[0]!('rename','missing');
      expect(mock).toHaveBeenLastCalledWith(target,{recursive:true,persistent:false},expect.any(Function));
      expect(closed).toHaveBeenCalledTimes(1);
      stop();callbacks[1]!('rename','manifest.json');
      expect(mock).toHaveBeenCalledTimes(2);
    } finally {stop();fs.rmSync(root,{recursive:true,force:true});mock.mockRestore();}
  });
  it('publishes version.wrapper_published only when a current release changes after the baseline', async () => {
    let current = '0.9.81';
    const registry = {
      invalidate: () => {},
      manifestForPlatform: async () => ({ engine: 'cxx', os: 'linux', arch: 'amd64', current, builds: [] }),
    } as unknown as WrapperBinRegistry;
    const events: string[] = [];
    const unsubscribe = wsPublisher.subscribe((e) => events.push(e.type));
    vi.useFakeTimers();
    try {
      let changed=()=>{};
      const stop = startWrapperPublishWatch(registry, {binRoot:'/fixture',error:err=>{throw err;},subscribe:callback=>{changed=callback;return ()=>{};}});
      await vi.advanceTimersByTimeAsync(1100);
      expect(events).not.toContain('version.wrapper_published');
      current = '0.9.82';
      changed();
      await vi.advanceTimersByTimeAsync(1100);
      expect(events.filter((t) => t === 'version.wrapper_published')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1100);
      expect(events.filter((t) => t === 'version.wrapper_published')).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      stop();
    } finally {
      vi.useRealTimers();
      unsubscribe();
    }
  });
});
