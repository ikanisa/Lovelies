"""Read exact native closure and removable operating-system package payloads.

Executed only in an owned read-only, network-none inspection container. It does
not modify runtime files, scan advisories, run service/test corpora or connect
providers. Libraries not in an ELF closure may still be dlopen targets, so this
inventory conservatively retains loader/NSS/codec plugin directory payloads.
"""
from __future__ import annotations
import hashlib,json,os,re,subprocess,sys
from pathlib import Path

FAMILIES={'acl','apt','coreutils','dash','diffutils','gcc-14','glibc','libpng1.6','ncurses','pam','perl','protobuf','shadow','sqlite3','systemd','tar','util-linux','zlib','dpkg','adduser','debconf','findutils','grep','sed','gzip','bzip2','xz-utils','readline','libcap2','libcap-ng','libgpg-error','libgcrypt20','libxxhash','libseccomp'}

def sha(p):
 h=hashlib.sha256()
 with p.open('rb')as f:
  for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
 return h.hexdigest()

def file_record(p):
 if p.is_symlink():return dict(path=str(p),kind='symlink',target=os.readlink(p),resolved_path=str(p.resolve()))
 return dict(path=str(p),kind='file',bytes=p.stat().st_size,sha256=sha(p))

def elf(p):
 try:
  with p.open('rb')as f:return f.read(4)==b'\x7fELF'
 except (OSError,IsADirectoryError):return False

def command(argv):
 r=subprocess.run(argv,capture_output=True,text=True,timeout=15)
 if r.returncode:raise RuntimeError('inspection command failed: '+str(argv)+': '+r.stderr.strip())
 return r.stdout

packages={}
for line in command(['dpkg-query','-W','-f=${Package}\t${Version}\t${source:Package}\t${source:Version}\n']).splitlines():
 name,version,source,sv=line.split('\t');packages[name]=dict(package=name,version=version,source_package=source or name,source_version=sv or version,files=[])
owners={}
for pkg,metadata in packages.items():
 info=list(Path('/var/lib/dpkg/info').glob(pkg+'.list'))+list(Path('/var/lib/dpkg/info').glob(pkg+':*.list'))
 for listing in info:
  for line in listing.read_text().splitlines():
   p=Path(line)
   if not p.is_absolute():continue
   owners.setdefault(str(p.resolve()),set()).add(pkg)
   if metadata['source_package']in FAMILIES and(p.is_file()or p.is_symlink())and not p.is_dir():
    metadata['files'].append(file_record(p))
roots={Path('/usr/local/bin/python3.13'),Path('/usr/local/lib/libpython3.13.so.1.0'),Path('/usr/bin/dash')}
roots.update(p.resolve() for p in Path('/app/.venv').rglob('*')if p.is_file()and elf(p))
roots.update(p for p in Path('/usr/local/lib/python3.13/lib-dynload').glob('*.so')if elf(p))
# libheif plugins are loaded with dlopen, not necessarily a DT_NEEDED edge.
plugin_paths=[]
for directory in [Path('/usr/lib/x86_64-linux-gnu/libheif'),Path('/usr/lib/x86_64-linux-gnu/ossl-modules')]:
 if directory.is_dir():
  for p in directory.rglob('*'):
   if p.is_file()and elf(p):roots.add(p);plugin_paths.append(str(p))
closure={};missing=[];root_records=[]
for p in sorted(roots):
 if not elf(p):raise RuntimeError('actual ELF root missing: '+str(p))
 raw=command(['ldd',str(p)])
 if 'not found'in raw:missing.append(dict(path=str(p),ldd=raw))
 paths=[]
 for line in raw.splitlines():
  match=re.search(r'(?:=>\s+)?(/[^\s]+)\s+\(',line)
  if match:
   target=Path(match.group(1)).resolve();paths.append(str(target));closure[str(target)]=file_record(target)
 root_records.append(dict(**file_record(p),resolved_path=str(p.resolve()),resolved_dependencies=paths,ldd=raw))
for path,v in closure.items():v['package_owners']=sorted(owners.get(path,[]))
# Entire glibc/NSS + dynamic trust/plugin configuration remains conservatively
# retained, including libraries absent from this static lookup.
for p in sorted(Path('/usr/lib/x86_64-linux-gnu').glob('libnss*.so*')):
 if p.is_file():closure.setdefault(str(p.resolve()),dict(**file_record(p.resolve()),package_owners=sorted(owners.get(str(p.resolve()),[]))))
configs={}
for n in ['/etc/nsswitch.conf','/etc/passwd','/etc/group','/etc/hosts','/etc/resolv.conf','/etc/ssl/openssl.cnf','/etc/ssl/certs/ca-certificates.crt']:
 p=Path(n)
 if p.is_file():configs[n]=file_record(p)
result=dict(schema='lovelies-readonly-native-runtime-closure-v1',python=sys.version,uid=os.getuid(),native_roots=root_records,required_resolved_files=list(closure.values()),dynamic_plugin_roots=plugin_paths,retained_configuration=configs,packages=[v for v in packages.values()if v['source_package']in FAMILIES],missing_dependencies=missing,service_command_requires_shell=True,limitations=['A package or library is not cleared only because Python does not import it.','Actual ELF dependencies and explicit dynamic plugin/NSS retention are conservative removal boundaries, not a complete call graph.','This probe neither executes advisory scanners nor accepts security/production/runtime correctness.'])
if missing:raise RuntimeError('actual missing native dependency')
print(json.dumps(result,indent=2))
