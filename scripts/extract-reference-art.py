#!/usr/bin/env python3
"""Extract noninteractive illustration artwork; retain all source UI as native controls."""
from pathlib import Path
from PIL import Image, ImageOps, ImageDraw
import hashlib, json, shutil

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'Lovelies-48-Screen-PNGs/screens'
OUT = ROOT / 'shared/reference-art'
OUT.mkdir(parents=True, exist_ok=True)
catalog = {row['id']: row for row in json.loads((ROOT/'shared/catalog.json').read_text())}
specs = [
    ('intro-collage.png', 2, (5,28,225,195)),
    ('processing-hero.png', 8, (36,55,190,218)),
    ('setup-hero.png', 9, (34,44,207,217)),
    ('upload-hero.png', 24, (38,27,222,128)),
    ('matches-hero.png', 25, (60,30,187,136)),
    ('sharing-hero.png', 34, (36,74,204,191)),
    ('empty-hero.png', 47, (51,38,203,182)),
    ('offline-hero.png', 48, (64,70,192,163)),
]
records = []
sheet = Image.new('RGB', (1024,510), '#0a0a0b')
draw = ImageDraw.Draw(sheet)
for index, (name, screen, box) in enumerate(specs):
    source = SOURCE / catalog[screen]['filename']
    asset = OUT / name
    crop = Image.open(source).convert('RGB').crop(box)
    crop.save(asset)
    records.append({'asset':name, 'screen':screen,
        'source':str(source.relative_to(ROOT)), 'crop_xyxy':list(box),
        'source_dimensions':[catalog[screen]['width'],catalog[screen]['height']],
        'size':list(crop.size), 'role':'Noninteractive illustration artwork only',
        'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),
        'asset_sha256':hashlib.sha256(asset.read_bytes()).hexdigest()})
    for destination in (ROOT/'ios/Lovelies/Resources',ROOT/'android/app/src/main/assets'):
        shutil.copy2(asset, destination/name)
    preview=ImageOps.contain(crop,(240,211))
    x=index%4*256+8; y=index//4*255+30
    sheet.paste(preview,(x,y))
    draw.text((x,y-20),name,fill='white')
(OUT/'manifest.json').write_text(json.dumps(records,indent=2)+'\n')
sheet.save(ROOT/'verification/reference-art-contact.jpg',quality=96)
print(f'Extracted {len(records)} illustration crops; source images unchanged.')
