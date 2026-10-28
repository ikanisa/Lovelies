#!/usr/bin/env python3
"""Compile real Android push source against offline fake platform bindings."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]
FIXTURE=ROOT/'scripts/test-fixtures/android-push-optout'
SOURCE=ROOT/'android/app/src/main/java/com/lovelies/frontend/preview'
LOCAL_KOTLINC=Path('/Volumes/PRO-G40/Applications/Android Studio.app/Contents/plugins/Kotlin/kotlinc/bin/kotlinc')

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def locate(value,fallback,name):
    candidate=Path(value).expanduser() if value else None
    if candidate is None:
        found=shutil.which(name)
        candidate=Path(found) if found else fallback
    if candidate is None or not candidate.is_file():raise RuntimeError(f'{name} not found; supply its explicit path')
    return candidate.resolve()

def run(args,out):
    kotlinc=locate(args.kotlinc,LOCAL_KOTLINC,'kotlinc')
    java=locate(args.java,None,'java')
    coroutines=Path(args.coroutines).expanduser().resolve() if args.coroutines else kotlinc.parent.parent/'lib/kotlinx-coroutines-core-jvm.jar'
    inputs=[Path(__file__).resolve(),SOURCE/'PushMessaging.kt',SOURCE/'NativeProtocol.kt',*sorted(FIXTURE.glob('*.kt')),kotlinc,java,coroutines]
    if not coroutines.is_file() or not (FIXTURE/'SignedOutOptOutTests.kt').is_file():raise RuntimeError('fixture or Kotlin coroutines jar missing')
    before={str(p):digest(p) for p in inputs}
    env=os.environ.copy()
    possible_java_home=java.parent.parent
    if (possible_java_home/'lib/modules').is_file():env['JAVA_HOME']=str(possible_java_home)
    compiler=([str(kotlinc)] if os.access(kotlinc,os.X_OK) else ['sh',str(kotlinc)])
    binary=out/'signed-out-optout.jar'
    compile_cmd=[*compiler,'-jvm-target','17','-cp',str(coroutines),'-include-runtime','-d',str(binary),
                 *[str(p) for p in sorted(FIXTURE.glob('*.kt'))],str(SOURCE/'NativeProtocol.kt'),str(SOURCE/'PushMessaging.kt')]
    test_cmd=[str(java),'-cp',str(binary)+os.pathsep+str(coroutines),'com.lovelies.frontend.preview.SignedOutOptOutTestsKt']
    sandbox=Path('/usr/bin/sandbox-exec')
    offline='macos-sandbox' if sys.platform=='darwin' and sandbox.is_file() else 'synthetic-fakes-only'
    if offline=='macos-sandbox':test_cmd=[str(sandbox),'-p','(version 1) (allow default) (deny network*)',*test_cmd]
    steps=[]
    for name,cmd,marker in (('compile',compile_cmd,None),('test',test_cmd,'RESULT total=15 passed=15 failed=0')):
        if name=='test' and steps[-1].get('exit')!=0:
            steps.append({'name':name,'skipped':'compile failed'});continue
        try:
            result=subprocess.run(cmd,cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=180)
            data,code,timeout=result.stdout,result.returncode,False
        except subprocess.TimeoutExpired as exc:data,code,timeout=exc.stdout or b'',None,True
        (out/(name+'.log')).write_bytes(data)
        hit=None if marker is None else marker in data.decode('utf-8',errors='replace')
        steps.append({'name':name,'command':cmd,'exit':code,'timeout':timeout,'marker_matches':hit,'log_sha256':hashlib.sha256(data).hexdigest()})
        if code!=0 or hit is False:sys.stderr.write(data.decode('utf-8',errors='replace')[-8000:])
    try:after={str(p):digest(p) for p in inputs};stable=before==after
    except OSError:stable=False
    passed=stable and all(s.get('exit')==0 and s.get('marker_matches') is not False for s in steps)
    report={'passed':passed,'source_inputs_stable':stable,'input_sha256':before,'test_process_offline_scope':offline,'steps':steps,
            'scope':'actual app push/protocol source plus synthetic same-account Android/Firebase fakes; no real provider or user notification',
            'toolchain_limit':'selected executable and coroutine jar are hashed; the entire JDK/compiler dependency closure is not'}
    (out/'result.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'passed':passed,'source_inputs_stable':stable,'test_process_offline_scope':offline,'evidence':str(out) if args.evidence_dir else None}))
    return 0 if passed else 1

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kotlinc',default=os.environ.get('KOTLINC'))
    parser.add_argument('--java',default=os.environ.get('JAVA'))
    parser.add_argument('--coroutines',default=os.environ.get('KOTLIN_COROUTINES_JAR'))
    parser.add_argument('--evidence-dir',help='absolute path to a new directory; omitted for temporary output')
    args=parser.parse_args()
    try:
        if args.evidence_dir:
            out=Path(args.evidence_dir)
            if not out.is_absolute() or out.exists():raise RuntimeError('evidence directory must be absolute and not already exist')
            out.mkdir(parents=False);return run(args,out)
        with tempfile.TemporaryDirectory(prefix='lovelies-push-optout-') as name:return run(args,Path(name))
    except (OSError,RuntimeError) as exc:
        print(f'push opt-out test unavailable: {exc}',file=sys.stderr);return 1

if __name__=='__main__':sys.exit(main())
