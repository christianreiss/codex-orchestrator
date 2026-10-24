import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const script = resolve(import.meta.dirname, '../../../../scripts/deploy-detached.py');
function python(body: string) {
  return execFileSync('python3', ['-c', `import importlib.util, tempfile, pathlib, sys, json, subprocess\nfrom unittest.mock import patch\nspec=importlib.util.spec_from_file_location('deploy', ${JSON.stringify(script)})\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\n${body}`], { encoding: 'utf8' });
}
describe('detached self-deployment', () => {
  it('keeps HOME/PATH and records acceptance separately from completion', () => {
    const output = python(`with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp)
 (root/'scripts').mkdir()
 m.__file__=str(root/'scripts'/'deploy-detached.py')
 sys.argv=['deploy-detached.py','--','--backup','--service','api']
 calls=[]
 with patch.object(m.subprocess,'check_output',return_value='a'*40), patch.object(m.subprocess,'run',side_effect=lambda command, **kwargs: calls.append(command)):
  assert m.main()==0
 command=calls[0]
 assert command[0]=='systemd-run'
 assert any(arg.startswith('--setenv=HOME=') for arg in command)
 assert any(arg.startswith('--setenv=PATH=') for arg in command)
 result=next((root/'backups'/'deployments').glob('*/result.json'))
 assert json.loads(result.read_text())['status']=='accepted'
 assert '--supervise' in command
 print('verified')`);
    expect(output).toContain('verified');
  });
  it.each([0, 7])('persists supervisor exit %s without claiming transport acceptance is success', (code) => {
    const output = python(`with tempfile.TemporaryDirectory() as tmp:
 directory=pathlib.Path(tmp)
 sys.argv=['deploy-detached.py','--supervise',tmp,'--','--service','api']
 with patch.object(m.subprocess,'check_output',return_value='b'*40), patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],${code})):
  assert m.main()==${code}
 result=json.loads((directory/'result.json').read_text())
 assert result['exit_code']==${code}
 assert result['status']==${JSON.stringify(code === 0 ? 'succeeded' : 'failed')}
 assert result['commit']=='b'*40
 assert (directory/'deploy.log').exists()
 print('verified')`);
    expect(output).toContain('verified');
  });
});
