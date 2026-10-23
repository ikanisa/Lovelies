from pathlib import Path
import ctypes, hashlib, json, os, subprocess
ROOT=Path('/proof')
def ref(p):
 p=Path(p); return {'path':str(p),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
def read_inputs():
 expected=json.loads((ROOT/'completed-tree-inputs.json').read_text())
 actual=[ref(row['path']) for row in expected]
 assert actual==expected, 'Completed compiled tree or unchanged vendor source changed'
 return actual
inputs=read_inputs()
pid=os.fork()
if pid==0:
 libc=ctypes.CDLL(None,use_errno=True)
 result=[]
 for name,flag in [('CLONE_NEWUTS',0x04000000),('CLONE_NEWNET',0x40000000)]:
  status=libc.unshare(flag); err=ctypes.get_errno() if status else 0
  result.append({'namespace':name,'result':status,'errno':err})
 (ROOT/'actual-sidecar-namespace-probe.json').write_text(json.dumps(result,indent=2)+'\n')
 os._exit(0 if all(row['result']==0 for row in result) else 1)
_,status=os.waitpid(pid,0)
assert os.waitstatus_to_exitcode(status)==0, 'Required fixture namespaces remain unavailable'
records=[]
for name in ['tst-resolv-res_init','tst-resolv-res_init-thread']:
 command=['/glibc/build/testrun.sh','/glibc/build/resolv/'+name]
 p=subprocess.run(command,capture_output=True,timeout=180)
 output=ROOT/(name+'.out'); output.write_bytes(p.stdout+p.stderr)
 evaluation=subprocess.run(['sh','/glibc/source/glibc-2.41/scripts/evaluate-test.sh','resolv/'+name,str(p.returncode),'false','true'],capture_output=True)
 result=ROOT/(name+'.test-result'); result.write_bytes(evaluation.stdout)
 records.append({'name':name,'command':command,'exit_code':p.returncode,'vendor_evaluation_exit_code':evaluation.returncode,'output':ref(output),'result':ref(result),'status_text':evaluation.stdout.decode()})
 (ROOT/'fixture-results.json').write_text(json.dumps(records,indent=2)+'\n')
 assert p.returncode==0 and evaluation.returncode==0 and evaluation.stdout.startswith(b'PASS:'), 'Unchanged vendor resolver fixture failed'
 assert b'SKIP:' not in output.read_bytes() and b'could not enter network namespace' not in output.read_bytes(), 'Required vendor case was skipped'
assert read_inputs()==inputs
(ROOT/'fixture-execution.json').write_text(json.dumps({'schema':'lovelies-glibc-resolver-fixture-execution-v1','status':'PASS_UNCHANGED_VENDOR_RESOLVER_FIXTURES','uid':os.getuid(),'inputs':inputs,'tests':records,'source_inputs_and_binary_bytes_unchanged':True,'compilation_performed':False,'namespace_mock_or_test_source_change':False},indent=2)+'\n')
print(json.dumps({'status':'PASS_UNCHANGED_VENDOR_RESOLVER_FIXTURES','tests':len(records)}))
