"""Reproducible photo-only crop extraction from retained Lovelies reference PNGs.

No image is enlarged, sharpened or replaced. Geometry uses original source pixels.
Source controls that cross a photo are documented and covered by real controls.
"""
from pathlib import Path
import hashlib
import json
from PIL import Image

BASE = Path(__file__).resolve().parents[2]
SOURCE = BASE / 'Lovelies-48-Screen-PNGs/screens'
DEST = Path(__file__).resolve().parent
ASSETS = DEST / 'assets'
ASSETS.mkdir(parents=True, exist_ok=True)

# rect = [left, top, right, bottom]; controls likewise use original source pixels.
def tile(identifier, rect, selected=None, badge=None, control=None, people=None, source=None, crop=None, asset=None, **extra):
    return dict(id=identifier, rect=rect, selected=selected, badge=badge,
                control=control, people=people, source=source, crop=crop,
                asset=asset, **extra)

configs = {
    11: {'bounds':[10,122,232,317], 'tiles':[
        tile(1,[11,123,85,197],True,'selection',[60,145,81,167]),
        tile(2,[90,123,160,224],True,'selection',[133,154,154,176]),
        tile(3,[165,123,232,199]),
        tile(4,[11,201,85,269],True,'selection',[59,240,80,262]),
        tile(5,[90,229,160,299],True,'selection',[131,268,153,290]),
        tile(6,[165,203,232,269],True,'selection',[204,212,226,235]),
        tile(7,[11,273,85,316]),tile(8,[90,304,160,317]),tile(9,[165,274,232,317])]},
    14: {'bounds':[11,99,241,487], 'tiles':[
        tile(1,[11,100,80,189]),
        tile(2,[87,100,164,166],True,'favorite',[133,103,162,131]),
        tile(3,[170,100,240,196],True,'favorite',[208,102,237,130]),
        tile(4,[11,196,80,276],True,'favorite-outline',[51,199,79,227]),
        tile(5,[11,282,80,368],True,'selection',[51,283,79,312]),
        tile(6,[87,172,164,247]),tile(7,[87,253,164,330]),
        tile(8,[170,202,240,307]),tile(9,[11,374,80,449]),
        tile(10,[87,337,164,392]),tile(11,[170,313,240,407]),
        tile(12,[87,398,164,484]),tile(13,[170,414,240,484]),tile(14,[11,456,80,484])]},
    15: {'bounds':[10,310,243,487], 'tiles':[
        tile(1,[10,311,84,412]),tile(2,[89,311,163,372]),tile(3,[169,311,242,372]),
        tile(4,[10,418,84,480],True,'selection',[53,420,81,449]),
        tile(5,[89,378,163,480]),
        tile(6,[169,378,242,441],True,'selection',[211,382,240,410]),
        tile(7,[169,447,242,482],True,'selection',[211,450,240,478])]},
    21: {'bounds':[8,75,247,314], 'tiles':[
        tile(1,[8,75,62,143],True,'selection',[38,78,62,103]),
        tile(2,[68,75,123,143]),
        tile(3,[129,75,184,153],True,'selection',[159,78,184,103]),
        tile(4,[191,75,246,152],True,'selection',[219,78,244,104]),
        tile(5,[8,149,62,216]),
        tile(6,[68,149,123,216],True,'selection',[97,151,122,178]),
        tile(7,[129,159,184,249]),tile(8,[191,158,246,230]),
        tile(9,[8,221,62,286]),
        tile(10,[68,221,123,286],True,'selection',[97,223,122,250]),
        tile(11,[129,254,184,311],True,'selection',[159,255,184,281]),
        tile(12,[191,236,246,311],True,'selection',[218,237,245,263]),
        tile(13,[8,292,62,312]),
        tile(14,[68,292,123,312],True,'selection',[98,295,122,314]),
        tile(15,[8,314,62,335],True,'selection',source=21,crop=[8,221,62,286],latent=True),
        tile(16,[68,314,123,335],True,'selection',source=21,crop=[68,221,123,286],latent=True),
        tile(17,[129,314,184,335],True,'selection',source=21,crop=[129,254,184,311],latent=True),
        tile(18,[191,314,246,335],True,'selection',source=21,crop=[191,236,246,311],latent=True)]},
    26: {'bounds':[8,72,227,377], 'tiles':[
        tile(1,[9,73,112,191],people=[87,161,108,184]),
        tile(4,[117,73,226,148],people=[200,123,220,142]),
        tile(8,[9,196,112,248]),tile(9,[117,153,167,207]),
        tile(5,[173,153,226,231]),tile(10,[118,212,166,291]),
        tile(12,[172,237,226,291],people=[200,267,222,286]),
        tile(11,[9,254,86,327]),tile(7,[91,254,113,374],people=[93,346,113,368]),
        tile(6,[117,296,226,355]),tile(2,[9,333,86,374]),
        tile(3,[118,361,154,377]),tile(2,[159,361,189,377]),tile(5,[192,361,226,377])],
        'reconciliation':'The source depicts 14 photo rectangles while labelling 12 matched photos. Two partial bottom fragments are render variants: nearest city fragment uses logical photo 2 and cathedral fragment uses logical photo 5. This logical identity is a demo presentation assumption because the supplied source is partial; exact individual crop bytes and positions are retained.'},
    28: {'bounds':[12,163,235,377], 'tiles':[
        tile(1,[13,164,86,287]),tile(4,[91,164,159,249]),tile(7,[165,164,235,226]),
        tile(9,[13,293,86,369]),tile(5,[91,254,159,369]),
        tile(3,[165,232,235,316]),tile(6,[165,321,235,375])]},
    29: {'bounds':[8,72,230,328], 'tiles':[
        tile(1,[9,73,98,191],True,'selection',[71,78,94,103],people=[72,169,95,191]),
        tile(4,[102,73,163,147],True,'selection',[139,78,161,104]),
        tile(7,[168,73,229,139],False,'selection',[207,78,228,102],people=[210,127,231,148]),
        tile(8,[9,196,98,254],True,'selection',people=[73,231,96,253]),
        tile(6,[102,152,163,208],True,'selection',[139,155,163,180]),
        tile(9,[168,144,229,207],True,'selection',[207,155,229,179]),
        tile(10,[102,211,163,292],True,'selection',[139,215,162,240]),
        tile(2,[168,213,229,265],False,'selection',[207,215,229,241]),
        tile(11,[9,259,98,328],True,'selection',[72,263,95,288]),
        tile(12,[168,270,229,328],True,'selection',[207,272,229,298]),
        tile(3,[102,296,163,328],False,'selection',source=26,crop=[117,296,226,355]),
        tile(5,[168,328,229,348],False,'selection',source=33,crop=[124,130,174,172],latent=True)]},
    30: {'bounds':[8,72,231,328], 'dimmed':True, 'tiles':[
        tile(1,[9,74,100,192],True,'selection',[76,78,98,103]),
        tile(4,[104,74,165,148],False,'selection',[142,77,166,102]),
        tile(7,[170,74,231,139],False,'selection',[208,77,231,102]),
        tile(8,[9,197,100,254],False,'selection',[76,199,100,222]),
        tile(6,[104,153,165,209],False,'selection',[142,155,166,180]),
        tile(9,[170,145,231,208],True,'selection',[208,155,230,179]),
        tile(10,[104,212,165,292],True,'selection',[142,216,165,241]),
        tile(2,[170,213,231,266],False,'selection',[208,216,231,241]),
        tile(11,[9,260,100,328],False,'selection',[76,263,99,288]),
        tile(12,[170,271,231,328],True,'selection',[208,273,231,298]),
        tile(3,[104,297,165,328],True,'selection'),
        tile(5,[170,328,231,348],True,'selection',latent=True)]},
    33: {'bounds':[15,82,229,173], 'tiles':[
        tile(1,[15,83,66,173]),tile(2,[70,83,120,112]),tile(3,[70,116,120,173]),
        tile(4,[124,83,174,128]),tile(5,[124,131,174,173]),
        tile(1,[178,83,228,130]),tile(6,[178,134,228,173])],
        'reconciliation':'Seven source photo rectangles represent six logical photos. Hero and upper-right hat portrait are two crops/variants of logical photo 1, as visually reconciled by the coordinating owner. Both obey the same selection state.'},
    37: {'bounds':[12,301,246,410], 'tiles':[
        tile(1,[13,302,86,374]),tile(2,[91,302,167,350]),tile(3,[173,302,245,376]),
        tile(4,[13,379,86,410]),tile(5,[91,355,167,410]),tile(6,[173,381,245,410])]},
    38: {'bounds':[20,274,226,325], 'cameraRect':[39,111,210,265], 'tiles':[
        tile(1,[20,275,73,324],True,crop=[29,281,65,317]),
        tile(2,[82,278,125,322],crop=[84,279,123,320]),
        tile(3,[131,278,176,322],crop=[133,279,174,320]),
        tile(4,[182,278,226,322],crop=[184,279,224,320])]},
}

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

sources = {n:next(SOURCE.glob(f'{n:02d}-*.png')) for n in configs}
images = {n:Image.open(p).convert('RGB') for n,p in sources.items()}
layouts = {}
manifest = {'schema':1,'sourcePreservation':'Original PNGs are unchanged. Crops retain source resolution and no enhancement is applied.','controlCoordinates':'controlBounds and peopleBadgeBounds are [x,y,width,height] normalized to the tile image; badgeX and badgeY are normalized center coordinates; badgeSize is diameter divided by min(tile width,tile height). Baked source controls must be fully covered by an opaque actual interactive control.','assets':[], 'reconciliations':[]}

for route, config in configs.items():
    bx1,by1,bx2,by2 = config['bounds']
    layout={'sourceBounds':config['bounds'],'tiles':[]}
    if config.get('dimmed'): layout['dimmed']=True
    if config.get('reconciliation'):
        layout['reconciliation']=config['reconciliation']
        manifest['reconciliations'].append({'screen':route,'detail':config['reconciliation']})
    for ordinal, item in enumerate(config['tiles'],1):
        x1,y1,x2,y2=item['rect']
        source_route=item['source'] or route
        crop=item['crop'] or item['rect']
        asset=f'ref{route:02d}_{ordinal:02d}.jpg'
        if route==30:
            peer=next(t for t in layouts['29']['tiles'] if t['id']==item['id'])
            asset=peer['asset']
        else:
            images[source_route].crop(crop).save(ASSETS/asset,'JPEG',quality=96,subsampling=0)
            manifest['assets'].append({'asset':asset,'source':str(sources[source_route].relative_to(BASE)),'sourceSha256':sha(sources[source_route]),'crop':crop,'sourceResolution':list(images[source_route].size),'pixelSize':[crop[2]-crop[0],crop[3]-crop[1]],'sha256':sha(ASSETS/asset)})
        entry={'id':item['id'],'asset':asset,'x':(x1-bx1)/(bx2-bx1),'y':(y1-by1)/(by2-by1),'width':(x2-x1)/(bx2-bx1),'height':(y2-y1)/(by2-by1)}
        if item['selected'] is not None: entry['selected']=item['selected']
        if item.get('latent'): entry['latent']=True
        if item['badge']:
            entry['badgeKind']='favorite' if item['badge'].startswith('favorite') else 'selection'
            if item['badge']=='favorite-outline':entry['badgeOutlined']=True
        if item['control']:
            cx1,cy1,cx2,cy2=item['control'];w=x2-x1;h=y2-y1
            entry.update(controlBaked=True,controlBounds=[(cx1-x1)/w,(cy1-y1)/h,(cx2-cx1)/w,(cy2-cy1)/h],badgeX=((cx1+cx2)/2-x1)/w,badgeY=((cy1+cy2)/2-y1)/h,badgeSize=max(cx2-cx1,cy2-cy1)/min(w,h))
        if item['people']:
            px1,py1,px2,py2=item['people'];w=x2-x1;h=y2-y1
            entry['peopleBadge']=True
            entry['peopleBadgeBounds']=[(px1-x1)/w,(py1-y1)/h,(px2-px1)/w,(py2-py1)/h]
        layout['tiles'].append(entry)
    if config.get('cameraRect'):
        asset=f'ref{route:02d}_camera.jpg';crop=config['cameraRect']
        images[route].crop(crop).save(ASSETS/asset,'JPEG',quality=96,subsampling=0)
        layout['cameraAsset']=asset;layout['cameraSourceBounds']=crop
        manifest['assets'].append({'asset':asset,'source':str(sources[route].relative_to(BASE)),'sourceSha256':sha(sources[route]),'crop':crop,'sourceResolution':list(images[route].size),'pixelSize':[crop[2]-crop[0],crop[3]-crop[1]],'sha256':sha(ASSETS/asset),'note':'Own Jasmine camera photograph with its noninteractive face bracket depiction.'})
    layouts[str(route)]=layout

# Source15 recent-category photographs are separate image crops, not the labels.
recent=[]
for ordinal,crop in enumerate([[12,199,63,251],[75,199,128,251],[137,199,189,251],[202,199,242,251]],1):
    asset=f'ref15_recent{ordinal:02d}.jpg'
    images[15].crop(crop).save(ASSETS/asset,'JPEG',quality=96,subsampling=0)
    recent.append(asset)
    manifest['assets'].append({'asset':asset,'source':str(sources[15].relative_to(BASE)),'sourceSha256':sha(sources[15]),'crop':crop,'sourceResolution':list(images[15].size),'pixelSize':[crop[2]-crop[0],crop[3]-crop[1]],'sha256':sha(ASSETS/asset)})
layouts['15']['recentAssets']=recent

(DEST/'layouts.json').write_text(json.dumps(layouts,indent=2)+'\n')
(DEST/'asset-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(f'Extracted {len(manifest["assets"])} photo crops for {len(layouts)} source layouts.')
