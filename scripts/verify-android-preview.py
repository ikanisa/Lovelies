#!/usr/bin/env python3
"""Render each reference route in the installed, isolated Android frontend.

Runs against an explicitly chosen emulator. Captures the actual native display and
accessibility hierarchy; passing does not establish screenshot pixel parity.
"""
from pathlib import Path
import argparse, atexit, hashlib, json, re, subprocess, time, xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = 'com.lovelies.frontend.preview'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--serial', required=True)
    parser.add_argument('--screens', default='1-48')
    parser.add_argument('--reference-viewports', action='store_true',
        help='Match each supplied screenshot aspect for layout inspection, then restore display size.')
    parser.add_argument('--output-folder', help='New evidence folder; previous verification captures are preserved.')
    args = parser.parse_args()
    output_name = 'android-reference' if args.reference_viewports else 'android'
    out = Path(args.output_folder).resolve() if args.output_folder else ROOT / 'verification' / output_name
    summary_path = out/'screen-rendering.json' if args.output_folder else ROOT/'verification'/f'{output_name}-screen-rendering.json'
    out.mkdir(parents=True, exist_ok=True)
    routes = json.loads((ROOT / 'shared/catalog.json').read_text())
    if '-' in args.screens:
        first, last = map(int, args.screens.split('-'))
        wanted = range(first, last + 1)
    else:
        wanted = [int(x) for x in args.screens.split(',')]
    rows = []
    def adb(*parts, binary=False):
        return subprocess.run(['adb', '-s', args.serial, *parts],
            capture_output=True, text=not binary, timeout=25, check=True).stdout
    installed_apk = adb('shell', 'pm', 'path', PACKAGE).splitlines()[0].removeprefix('package:')
    installed_sha256 = adb('shell', 'sha256sum', installed_apk).split()[0]
    if args.reference_viewports:
        display = adb('shell', 'wm', 'size')
        original_override = re.search(r'Override size: (\d+x\d+)', display)
        restore_size = original_override.group(1) if original_override else 'reset'
        atexit.register(lambda: adb('shell', 'wm', 'size', restore_size))
    for route in routes:
        screen = route['id']
        if screen not in wanted:
            continue
        row = {'id':screen, 'title':route['title']}
        try:
            if args.reference_viewports:
                height = round(1080 * route['height'] / route['width'])
                adb('shell', 'wm', 'size', f'1080x{height}')
                row['reference_viewport'] = [1080, height]
            adb('shell', 'am', 'force-stop', PACKAGE)
            adb('shell', 'am', 'start', '-W', '-n', PACKAGE + '/.MainActivity',
                '--ei', 'screen', str(screen), '--ez', 'review', 'true')
            time.sleep(.35)
            adb('shell', 'uiautomator', 'dump', '/sdcard/lovelies-frontend-review.xml')
            xml = adb('shell', 'cat', '/sdcard/lovelies-frontend-review.xml')
            tree = ET.fromstring(xml)
            descriptions = [x.get('content-desc', '') for x in tree.iter('node')]
            if 'Explore the screens' in [x.get('text','') for x in tree.iter('node')]:
                # Native prototype disclosure, not a platform permission request.
                node = next(x for x in tree.iter('node') if x.get('text') == 'Explore the screens')
                x1,y1,x2,y2 = map(int, re.findall(r'\d+', node.get('bounds','')))
                adb('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2))
                adb('shell', 'uiautomator', 'dump', '/sdcard/lovelies-frontend-review.xml')
                xml = adb('shell', 'cat', '/sdcard/lovelies-frontend-review.xml')
                tree = ET.fromstring(xml)
                descriptions = [x.get('content-desc','') for x in tree.iter('node')]
            marker = f'Screen {screen:02d}:'
            row['route_semantics_present'] = any(marker in d for d in descriptions)
            row['process_alive'] = bool(adb('shell', 'pidof', PACKAGE).strip())
            row['hierarchy'] = f'{output_name}/{screen:02d}.xml'
            (out / f'{screen:02d}.xml').write_text(xml)
            picture = adb('exec-out', 'screencap', '-p', binary=True)
            (out / f'{screen:02d}.png').write_bytes(picture)
            row['screenshot'] = f'{output_name}/{screen:02d}.png'
            row['screenshot_sha256'] = hashlib.sha256(picture).hexdigest()
            row['passed'] = row['route_semantics_present'] and row['process_alive']
        except Exception as error:
            row.update(passed=False, error=str(error))
        rows.append(row)
        summary_path.write_text(
            json.dumps({'serial':args.serial,'scope':'Native route rendering; no pixel-parity claim',
                'installed_apk_sha256':installed_sha256,
                'viewport_mode':'Source aspect' if args.reference_viewports else 'Device display',
                'routes':rows,'passed':sum(r['passed'] for r in rows),'total':len(rows)},indent=2)+'\n')
        print(f"{screen:02d} {route['title']}: {'PASS' if row['passed'] else 'FAIL'}",flush=True)
    raise SystemExit(0 if rows and all(r['passed'] for r in rows) else 1)

if __name__ == '__main__':
    main()
