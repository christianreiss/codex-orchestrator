import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildKnowledge } from '../src/services/chatty/knowledge.js';

export function writeChattyKnowledge(apiRoot: string, dist: string) {
  const bundle = buildKnowledge(resolve(apiRoot, '..'));
  if (!bundle.sources.length)
    throw new Error('Chatty product documentation is missing from the build context');
  writeFileSync(resolve(dist, 'chatty-knowledge.json'), JSON.stringify(bundle));
}
