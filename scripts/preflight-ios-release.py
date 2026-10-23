#!/usr/bin/env python3
"""Read a built app; static checks cannot certify hosted/device/store acceptance."""
import argparse,json,plistlib,re,subprocess
from pathlib import Path
from urllib.parse import urlsplit
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--app',required=True,type=Path);p.add_argument('--highest-uploaded-build',type=int);a=p.parse_args()
info=plistlib.loads((a.app/'Info.plist').read_bytes());issues=[]
if info.get('CFBundleIdentifier')!='com.lovelies.memories':issues.append('Existing App Store bundle identity differs')
if info.get('LoveliesAPIOrigin')!='https://ltqfplqevxztlswlzexn.supabase.co/functions/v1/lovelies-api':issues.append('Wrong Supabase Edge API')
link_host=info.get('LoveliesLinkHost','')
domain_label=r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
valid_link_host=isinstance(link_host,str) and len(link_host)<=253 and bool(re.fullmatch(r'(?:'+domain_label+r'\.)+'+domain_label,link_host)) and not bool(re.fullmatch(r'[0-9.]+',link_host))
if not valid_link_host:issues.append('LoveliesLinkHost must be the approved published DNS host without a scheme, path, port or wildcard')
for key in ['LoveliesPrivacyPolicyURL','LoveliesTermsURL','LoveliesSupportURL','LoveliesAccountDeletionURL']:
 url=urlsplit(info.get(key,''))
 if url.scheme!='https' or not url.hostname or url.username or url.password or url.query or url.fragment:issues.append(key+' must be an approved published HTTPS resource')
if a.highest_uploaded_build is None:issues.append('Highest uploaded App Store build has not been verified/supplied')
elif not str(info.get('CFBundleVersion','')).isdigit() or int(info['CFBundleVersion'])<=a.highest_uploaded_build:issues.append('Build number must exceed current uploaded maximum')
files=[f.name for f in a.app.rglob('*') if f.is_file()]
if any(re.fullmatch(r'(ref.*\.jpg|photo.*\.jpg|home.*\.jpg|person.*\.jpg|portrait\.jpg|retry-portrait\.jpg|catalog\.json|home-grid\.json|reference-grids\.json)',name) for name in files):issues.append('Reference fixtures are bundled')
if 'PrivacyInfo.xcprivacy' not in files:issues.append('Privacy manifest absent')
verify=subprocess.run(['codesign','--verify','--deep','--strict',str(a.app)],capture_output=True)
if verify.returncode:issues.append('Valid release signature absent')
else:
 signed=subprocess.run(['codesign','-d','--entitlements',':-',str(a.app)],capture_output=True)
 try:
  ent=plistlib.loads(signed.stdout)
  if ent.get('get-task-allow') is not False:issues.append('Development/debug entitlement present')
  if ent.get('application-identifier')!='63STJ5N27W.com.lovelies.memories':issues.append('Existing verified signing team/application identifier differs')
  if ent.get('aps-environment')!='production':issues.append('Production APNs entitlement absent')
  if not valid_link_host or ent.get('com.apple.developer.associated-domains')!=['applinks:'+link_host]:issues.append('Signed Associated Domains must contain only the configured approved applinks host')
 except Exception:issues.append('Release entitlements could not be verified')
print(json.dumps({'status':'blocked' if issues else 'static_checks_passed','scope':'Read-only artifact preflight; policies/hosted services/providers/device/TestFlight/App Store still require acceptance','bundle':info.get('CFBundleIdentifier'),'build':info.get('CFBundleVersion'),'issues':issues},indent=2));raise SystemExit(bool(issues))
