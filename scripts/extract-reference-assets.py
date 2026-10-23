#!/usr/bin/env python3
"""Extract the owner's artwork and photographs from supplied low-res mockups.
Original PNGs are read only. Reproducible crops are recorded with source hashes.
These are preview assets: crops cannot recover resolution absent from the source.
"""
from pathlib import Path
from PIL import Image, ImageDraw
import hashlib, json, shutil

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'Lovelies-48-Screen-PNGs/screens'
OUT = ROOT / 'shared/assets'
OUT.mkdir(parents=True, exist_ok=True)
records = []

def extract(name, source, box, subject, transparent=False):
    original = SOURCE / source
    image = Image.open(original).convert('RGBA' if transparent else 'RGB').crop(box)
    if transparent:
        pixels = list(image.getdata())
        rgba = []
        for r,g,b,a in pixels:
            if name == 'wordmark.png':
                opacity = max(0, min(255, round((r-g-27)*3.2))) if r > 120 else 0
            else:
                opacity = max(0, min(255, round((max(r,g,b)-28)*2.2)))
            rgba.append((r,g,b,opacity))
        image.putdata(rgba)
    image.save(OUT / name, quality=96)
    records.append({'asset':name,'subject':subject,'source':str(original.relative_to(ROOT)),
      'source_sha256':hashlib.sha256(original.read_bytes()).hexdigest(),'crop_xyxy':box,
      'size':list(image.size),'asset_sha256':hashlib.sha256((OUT/name).read_bytes()).hexdigest()})

extract('photo01.jpg','12-photo-viewer.png',(6,52,220,309),'Woman with hat overlooking the sea at sunset')
photos = [
 ('13-all-photos.png',(16,119,83,208),'Coastal village and harbour'),
 ('13-all-photos.png',(179,119,244,183),'Golden dog portrait'),
 ('13-all-photos.png',(17,219,83,309),'Sunlit cathedral'),
 ('13-all-photos.png',(179,194,244,262),'Friends in the village'),
 ('13-all-photos.png',(94,243,167,319),'Swimming by the coast'),
 ('13-all-photos.png',(94,330,168,404),'Mountain village and lake'),
 ('13-all-photos.png',(179,274,244,369),'Woman sitting in a town square'),
 ('13-all-photos.png',(17,322,83,367),'Dog in the garden'),
 ('13-all-photos.png',(18,380,83,481),'Man travelling through a town'),
 ('13-all-photos.png',(94,419,167,481),'Woman in sunshine'),
 ('13-all-photos.png',(179,381,244,446),'Evening celebration'),
 ('28-person-to-photos.png',(92,166,157,249),'Colourful Mediterranean coastline'),
 ('28-person-to-photos.png',(165,167,232,225),'Bell tower at sunset'),
 ('28-person-to-photos.png',(92,259,157,368),'Cathedral facade'),
 ('28-person-to-photos.png',(165,235,232,310),'Woman by a mountain lake'),
 ('14-favorites-and-saved.png',(14,378,79,450),'Blonde woman enjoying the sun'),
 ('14-favorites-and-saved.png',(173,214,238,304),'Woman in a summer dress'),
]
for n,(source,box,subject) in enumerate(photos,2):
    extract(f'photo{n:02d}.jpg',source,box,subject)
extract('portrait.jpg','06-face-enrollment.png',(10,32,204,291),'Jasmine / Sophie portrait from the supplied enrollment illustration')
extract('retry-portrait.jpg','07-face-quality-retry.png',(23,43,194,169),'Exact retry-screen portrait, excluding the exclamation control')
for n,y in enumerate([72,107,139,171,206,237,269,303],1):
    if n == 1:
        extract('person01.jpg','28-person-to-photos.png',(81,40,164,123),'Sophie / Jasmine avatar')
    elif n == 2:
        extract('person02.jpg','36-report-incorrect-match.png',(87,36,149,98),'Mark avatar from the supplied report screen')
    else:
        extract(f'person{n:02d}.jpg','31-select-people-to-share-with.png',(15,y,41,y+26),
          ['Sophie','Mark','Emma','James','Olivia','Daniel','Maya','Lucas'][n-1])
extract('wordmark.png','03-sign-in-and-join.png',(49,51,193,131),'Original Lovelies handwritten pink wordmark',True)
extract('photo-heart.png','19-upload-entry.png',(56,88,192,191),'Original Lovelies photo and heart illustration',True)
extract('splash.jpg','01-splash.png',(9,30,207,120),'Pink bokeh background, excluding wordmark and controls')
home_boxes = [
    (9,71,69,136),(74,68,120,137),(126,67,174,109),(181,67,235,125),
    (10,142,45,207),(52,141,120,198),(126,114,174,182),(181,132,235,190),
    (10,215,55,264),(61,205,120,245),(126,187,174,242),(181,198,235,266),
    (10,272,55,314),(61,251,120,314),(126,248,174,314),(181,273,235,314),
    (181,273,235,314),(126,114,174,182)
]
home_tiles = []
for n,box in enumerate(home_boxes,1):
    extract(f'home{n:02d}.jpg','10-home-gallery.png',box,f'Home screenshot photograph {n}')
    x1,y1,x2,y2 = box
    if n <= 16:
        home_tiles.append({'id':n,'asset':f'home{n:02d}.jpg','x':(x1-8)/231,'y':(y1-65)/252,
            'width':(x2-x1)/231,'height':(y2-y1)/252})
(OUT.parent/'home-grid.json').write_text(json.dumps({'source_screen':10,'source_bounds':[8,65,239,317],
    'tiles':home_tiles},indent=2)+'\n')
(OUT/'asset-manifest.json').write_text(json.dumps(records,indent=2)+'\n')
originals=json.loads((ROOT/'Lovelies-48-Screen-PNGs/screen-manifest.json').read_text())
def group(n):
    if n<=9:return 'Setup'
    if n<=18:return 'Library'
    if n<=24:return 'Upload'
    if n<=36:return 'Sharing'
    return 'Profile'
(OUT.parent/'catalog.json').write_text(json.dumps([{'id':x['number'],'title':x['title'],
  'filename':x['filename'],'group':group(x['number']),'width':x['width'],'height':x['height'],
  'aspectRatio':x['width']/x['height']} for x in originals],indent=2)+'\n')
for record in records:
    name = record['asset']
    destinations = [ROOT/'ios/Lovelies/Resources', ROOT/('android/app/src/main/assets' if name in {'wordmark.png', 'photo-heart.png', 'splash.jpg'} else 'android/app/src/debug/assets')]
    for dest in destinations:
        dest.mkdir(parents=True, exist_ok=True)
        shutil.copy2(OUT/name, dest/name)
for dest in [ROOT/'ios/Lovelies/Resources', ROOT/'android/app/src/debug/assets']:
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copy2(OUT.parent/'catalog.json', dest/'catalog.json')
    shutil.copy2(OUT.parent/'home-grid.json', dest/'home-grid.json')
sheet=Image.new('RGB',(1020,1125),'#211c23');d=ImageDraw.Draw(sheet)
for i,record in enumerate(records):
    im=Image.open(OUT/record['asset']).convert('RGBA');im.thumbnail((145,135))
    x=(i%6)*170+8;y=(i//6)*125+22
    if record['asset']=='wordmark.png':im.thumbnail((145,85))
    sheet.paste(im,(x,y),im)
    d.text((x,y-16),record['asset'],fill='white')
sheet.save('/tmp/lovelies-assets-review.jpg')
print(f'Created {len(records)} source-derived assets and 48-route catalog; originals preserved.')
