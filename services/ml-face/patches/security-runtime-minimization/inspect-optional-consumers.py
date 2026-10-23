"""Targeted symlink-root and optional-module consumer inspection, no mutations."""
import ast,hashlib,importlib.abc,importlib.metadata,json,os,re,subprocess,sys
from pathlib import Path
OPTIONAL={'sqlite3','_sqlite3','readline','curses','_curses','_curses_panel'}
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
symlinks=[]
for p in Path('/app/.venv').rglob('*'):
 if p.is_symlink()and p.is_file():
  with p.open('rb')as f:iself=f.read(4)==b'\x7fELF'
  if iself:
   resolved=p.resolve();r=subprocess.run(['ldd',str(p)],capture_output=True,text=True,timeout=15)
   if r.returncode or 'not found'in r.stdout:raise RuntimeError('symlink native linkage missing')
   symlinks.append(dict(alias=str(p),target=os.readlink(p),path=str(resolved),bytes=resolved.stat().st_size,sha256=sha(resolved),ldd=r.stdout))
consumer_hits=[];scanned=0
for base in [Path('/app/src'),Path('/app/.venv/lib/python3.13/site-packages')]:
 for p in base.rglob('*.py'):
  if any(part in {'tests','test','benchmarks','testing','__pycache__'}for part in p.relative_to(base).parts):continue
  try:tree=ast.parse(p.read_bytes())
  except(SyntaxError,UnicodeDecodeError):continue
  scanned+=1
  for n in ast.walk(tree):
   modules=[]
   if isinstance(n,ast.Import):modules=[a.name for a in n.names]
   elif isinstance(n,ast.ImportFrom)and n.module:modules=[n.module]
   elif isinstance(n,ast.Call)and n.args and isinstance(n.args[0],ast.Constant)and isinstance(n.args[0].value,str):
    fun=ast.unparse(n.func)
    if fun.endswith(('import_module','__import__')):modules=[n.args[0].value]
   for module in modules:
    if module.split('.')[0]in OPTIONAL:consumer_hits.append(dict(path=str(p),line=n.lineno,module=module,file_sha256=sha(p)))
class DenyOptional(importlib.abc.MetaPathFinder):
 def find_spec(self,fullname,path=None,target=None):
  if fullname.split('.')[0]in OPTIONAL:raise ImportError('optional interactive/database feature disabled in proposed service scope')
sys.meta_path.insert(0,DenyOptional())
for n in list(sys.modules):
 if n.split('.')[0]in OPTIONAL:raise RuntimeError('inspection bootstrap already loaded optional feature')
import pictured_ml_face.main
stdlib=[]
for p in Path('/usr/local/lib/python3.13/lib-dynload').glob('*.so'):
 if p.name.split('.')[0]in OPTIONAL:stdlib.append(dict(path=str(p),bytes=p.stat().st_size,sha256=sha(p)))
log_metadata=[]
for n in ['/var/log/btmp','/var/log/wtmp','/var/log/lastlog']:
 p=Path(n)
 if p.exists():
  s=p.stat();log_metadata.append(dict(path=n,bytes=s.st_size,mode=oct(s.st_mode&0o777),uid=s.st_uid,gid=s.st_gid))
print(json.dumps(dict(schema='lovelies-targeted-optional-module-consumers-v1',symlink_native_roots=symlinks,production_python_source_files_scanned=scanned,source_consumer_hits=consumer_hits,service_import_with_optional_modules_denied=True,optional_native_modules=stdlib,optional_modules_loaded=[n for n in sys.modules if n.split('.')[0]in OPTIONAL],login_log_metadata=log_metadata,limitations=['Literal source consumers and actual app import are separate observations, not blanket security clearance.','The complete new image must also omit optional modules/libraries and pass affected service tests.','CPython interactive/sqlite/curses functionality is intentionally outside the ML service contract.']),indent=2))
