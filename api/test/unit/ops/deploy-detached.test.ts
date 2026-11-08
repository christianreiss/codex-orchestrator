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
 sys.argv=['deploy-detached.py','--','--no-backup','--service','api']
 calls=[]
 with patch.object(m.subprocess,'check_output',return_value='a'*40), patch.object(m.subprocess,'run',side_effect=lambda command, **kwargs: calls.append(command)):
  assert m.main()==0
 command=calls[0]
 assert command[0]=='systemd-run'
 assert any(arg.startswith('--setenv=HOME=') for arg in command)
 assert any(arg.startswith('--setenv=PATH=') for arg in command)
 result=next((root/'backups'/'deployments').glob('*/result.json'))
 accepted=json.loads(result.read_text())
 assert accepted['status']=='accepted'
 assert accepted['commit'] is None
 assert accepted['source_before_pull']=='a'*40
 assert '--supervise' in command
 assert command[command.index('--source-before-pull')+1]=='a'*40
 # The worker can start after the checkout already advanced; preserve the
 # launcher's original source and report the final checkout separately.
 sys.argv=command[command.index('--supervise'):]
 sys.argv.insert(0,'deploy-detached.py')
 with patch.object(m.subprocess,'check_output',return_value='c'*40), patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0)):
  assert m.main()==0
 completed=json.loads(result.read_text())
 assert completed['source_before_pull']=='a'*40
 assert completed['source_after_deploy']=='c'*40
 assert completed['commit']=='c'*40
 print('verified')`);
    expect(output).toContain('verified');
  });
  it.each([0, 7])('persists supervisor exit %s without claiming transport acceptance is success', (code) => {
    const output = python(`with tempfile.TemporaryDirectory() as tmp:
 directory=pathlib.Path(tmp)
 sys.argv=['deploy-detached.py','--supervise',tmp,'--','--service','api']
 with patch.object(m.subprocess,'check_output',side_effect=['a'*40,'b'*40]), patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],${code})):
  assert m.main()==${code}
 result=json.loads((directory/'result.json').read_text())
 assert result['exit_code']==${code}
 assert result['status']==${JSON.stringify(code === 0 ? 'succeeded' : 'failed')}
 assert result['source_before_pull']=='a'*40
 assert result['source_after_deploy']=='b'*40
 assert result['commit']==${code === 0 ? "'b'*40" : 'None'}
 assert (directory/'deploy.log').exists()
 print('verified')`);
    expect(output).toContain('verified');
  });
  it('records unknown provenance when deploy succeeds but final HEAD cannot be read', () => {
    const output = python(`with tempfile.TemporaryDirectory() as tmp:
 sys.argv=['deploy-detached.py','--supervise',tmp,'--source-before-pull','a'*40,'--','--service','api']
 with patch.object(m.subprocess,'check_output',side_effect=subprocess.CalledProcessError(128,['git'])), patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0)):
  assert m.main()==1
 result=json.loads((pathlib.Path(tmp)/'result.json').read_text())
 assert result['status']=='unknown'
 assert result['exit_code']==0
 assert result['commit'] is None
 assert result['source_after_deploy'] is None
 assert result['source_before_pull']=='a'*40
 assert result['provenance_error']
 print('verified')`);
    expect(output).toContain('verified');
  });
});
