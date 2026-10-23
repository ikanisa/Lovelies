#!/usr/bin/env python3
"""Exercise meaningful local frontend behavior through the installed native UI."""
from pathlib import Path
import argparse, json, re, subprocess, time, xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = 'com.lovelies.frontend.preview'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--serial', required=True)
    args = parser.parse_args()
    results = []
    def adb(*parts, binary=False):
        return subprocess.run(['adb','-s',args.serial,*parts],capture_output=True,
            text=not binary,check=True,timeout=25).stdout
    def dump():
        adb('shell','uiautomator','dump','/sdcard/lovelies-frontend-interactions.xml')
        return ET.fromstring(adb('shell','cat','/sdcard/lovelies-frontend-interactions.xml'))
    def launch(screen):
        adb('shell','am','force-stop',PACKAGE)
        adb('shell','am','start','-W','-n',PACKAGE+'/.MainActivity',
            '--ei','screen',str(screen),'--ez','review','true')
        return dump()
    def tap(node):
        x1,y1,x2,y2=map(int,re.findall(r'\d+',node.get('bounds','')))
        adb('shell','input','tap',str((x1+x2)//2),str((y1+y2)//2))
    def route(tree):
        return next((int(re.search(r'Screen (\d+):',n.get('content-desc','')).group(1))
            for n in tree.iter('node') if re.search(r'Screen (\d+):',n.get('content-desc',''))),None)
    def record(name,passed,details):
        results.append({'name':name,'passed':bool(passed),'details':details})
        (ROOT/'verification/android-interactions.json').write_text(json.dumps(results,indent=2)+'\n')
        print(f"{name}: {'PASS' if passed else 'FAIL'}",flush=True)
    tree=launch(30)
    checks=[n for n in tree.iter('node') if n.get('checkable')=='true']
    record('Selected photos expose native checkbox state',
        bool(checks) and any(n.get('checked')=='true' for n in checks),
        {'checkable_tiles':len(checks),'checked_tiles':sum(n.get('checked')=='true' for n in checks)})
    for _ in range(16):
        selected=[n for n in tree.iter('node') if n.get('checked')=='true' and n.get('checkable')=='true']
        if selected:
            tap(selected[0]);tree=dump()
        elif any(n.get('text')=='0 of 12 selected' for n in tree.iter('node')):
            break
        else:
            adb('shell','input','swipe','950','1800','950','650','250');tree=dump()
    footer=next((n for n in tree.iter('node') if n.get('content-desc')=='Continue with selected photos'),None)
    zero=any(n.get('text')=='0 of 12 selected' for n in tree.iter('node'))
    record('Empty photo selection disables native Continue',zero and footer is not None and footer.get('enabled')=='false',
        {'zero_count':zero,'continue_enabled':footer.get('enabled') if footer is not None else None})
    (ROOT/'verification/android/empty-photos.png').write_bytes(adb('exec-out','screencap','-p',binary=True))
    tree=launch(32)
    for _ in range(8):
        selected=[n for n in tree.iter('node') if n.get('checked')=='true' and n.get('checkable')=='true']
        if not selected:break
        tap(selected[0]);tree=dump()
    zero=any(n.get('text')=='0 of 8 selected' for n in tree.iter('node'))
    # Compose reports disabled clickable rows as android.view.View on this SDK.
    # Match the actual action label and verify that tapping cannot leave the route.
    parents={child:parent for parent in tree.iter() for child in parent}
    continued=next((n for n in tree.iter('node')
        if n.get('text')=='Continue' or n.get('content-desc')=='Continue'),None)
    action=continued
    while action is not None and action.get('enabled')!='false':
        action=parents.get(action)
    disabled=action is not None
    if continued is not None:
        tap(continued);tree=dump()
    stayed=route(tree)==32
    record('Empty recipient selection disables native Continue',zero and disabled and stayed,
        {'zero_count':zero,'continue_disabled':disabled,'route_after_disabled_tap':route(tree)})
    (ROOT/'verification/android/empty-people.png').write_bytes(adb('exec-out','screencap','-p',binary=True))
    tree=launch(6);seen=[]
    for number in range(1,4):
        shutter=next(n for n in tree.iter('node') if n.get('content-desc','').startswith('Capture simulated selfie'))
        tap(shutter);tree=dump();seen.append(route(tree))
    record('Exactly three native sample captures begin processing',seen==[6,6,8],{'routes_after_each_capture':seen})
    (ROOT/'verification/android/three-captures.png').write_bytes(adb('exec-out','screencap','-p',binary=True))
    launch(10)
    raise SystemExit(0 if results and all(r['passed'] for r in results) else 1)

if __name__=='__main__':main()
