import { existsSync, watch } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { wsPublisher } from '../ws/publisher.js';
import { CXX_ARTIFACT, SUPPORTED_WRAPPER_PLATFORMS, type WrapperBinRegistry } from './wrapper-bin-registry.js';

export async function scanWrapperCurrent(binaries: WrapperBinRegistry): Promise<string> {
  binaries.invalidate();
  const parts: string[] = [];
  for (const platform of SUPPORTED_WRAPPER_PLATFORMS) {
    const manifest = await binaries.manifestForPlatform(CXX_ARTIFACT, platform);
    parts.push(`${platform}=${manifest?.current ?? ''}`);
  }
  return parts.join(',');
}

/** A manifest publication is the wakeup. Subscribe before the first scan so
 * publication during initial reading cannot disappear between the two. */
export function startWrapperPublishWatch(binaries: WrapperBinRegistry, options: {
  binRoot:string; error(error:unknown):void;
  subscribe?:(changed:()=>void)=>()=>void;
}): () => void {
  let last: string | null = null, running=false, dirty=false, closed=false;
  const tick = async () => {
    dirty=true;if(running||closed)return;
    running=true;
    try {
      while(dirty&&!closed){dirty=false;const current=await scanWrapperCurrent(binaries);
        if(!closed&&last!==null&&current!==last)wsPublisher.publish('version.wrapper_published',{});
        last=current;
      }
    } catch(error){if(!closed)options.error(error);} finally {running=false;}
  };
  const changed=()=>{void tick();};
  let stop:()=>void;
  if(options.subscribe)stop=options.subscribe(changed);
  else {
    const target=resolve(options.binRoot);let root=target;
    while(!existsSync(root)&&dirname(root)!==root)root=dirname(root);
    const watcher=watch(root,{recursive:true,persistent:false},(_kind,name)=>{
      if(!name){changed();return;}
      const path=resolve(root,String(name));
      if(path===target||path.startsWith(target+sep)||target.startsWith(path+sep))changed();
    });
    watcher.on('error',options.error);stop=()=>watcher.close();
  }
  changed();
  return ()=>{closed=true;stop();};
}
