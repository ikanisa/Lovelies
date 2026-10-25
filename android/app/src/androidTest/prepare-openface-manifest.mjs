/** Bind the existing shared OpenFace engineering stills for both native HTTP
 * runners. Generates metadata only; no image generation, network or credentials.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,realpath,stat,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';

const [inputDirectory,apiOrigin='http://127.0.0.1:18887']=process.argv.slice(2);
assert(inputDirectory,'Pass the existing createOpenFaceRuntime engineering fixture directory');
const directory=await realpath(resolve(inputDirectory)),api=new URL(apiOrigin);
assert.equal(api.protocol,'http:');assert(['127.0.0.1','localhost'].includes(api.hostname));
assert.equal(api.pathname,'/');assert(!api.username&&!api.password&&!api.search&&!api.hash);
assert((await stat(directory)).isDirectory());
const names=[...['a','b'].flatMap(slot=>Array.from({length:6},(_,index)=>`${slot}${index}.jpg`)),
 ...['P1','P2','P3','P4'].map(name=>`${name}.jpg`),...[0,1,2].map(index=>`no-face-${index}.jpg`)];
const files=await Promise.all(names.map(async name=>{
 const location=join(directory,name),resolved=await realpath(location);assert.equal(resolved,location,'Fixture links are not admitted');
 const bytes=await readFile(location);
 try{
  assert(bytes.length>3&&bytes.length<=8*1024*1024&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255,'A bounded JPEG fixture is required');
  return {path:name,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
 }finally{bytes.fill(0);}
}));
for(const label of ['a','b'])assert.equal(new Set(files.filter(row=>row.path.startsWith(label)).map(row=>row.sha256)).size,6,'Enrollment and fresh fixture encodings must be distinct');
assert.equal(new Set(files.filter(row=>row.path.startsWith('no-face-')).map(row=>row.sha256)).size,3,'Negative JPEG encodings must be distinct');
// Swift host runners accept absolute paths; Android opens the verified basename
// from its packaged assets. Bind the same exact source in both consumers.
const asset=name=>join(directory,name);
const fixture=slot=>({selfies:[0,1,2].map(index=>asset(`${slot}${index}.jpg`)),fresh_selfie:asset(`${slot}5.jpg`)});
const manifest={
 api_origin:api.origin,
 scope:'Existing supplied Lovelies screen-reference portraits, declared encoded derivatives and three synthetic white JPEG negative inputs; real OpenFace/Supabase consumer engineering inputs. Three encodings are not three optical captures. No camera, representative recognition, civil identity, hosted, device or release acceptance.',
 owner:fixture('a'),recipients:{aline:fixture('a'),eric:fixture('b')},
 camera_quality_recovery_selfies:[0,1,2].map(index=>asset(`no-face-${index}.jpg`)),
 photos:[{name:'P1',path:asset('P1.jpg'),matches:['aline']},{name:'P2',path:asset('P2.jpg'),matches:['aline','eric']},
  {name:'P3',path:asset('P3.jpg'),matches:['eric']},{name:'P4',path:asset('P4.jpg'),matches:['aline','eric']}],
 exclusions:[{photo:'P4',recipient:'eric'}],global_excluded_photos:['P3'],
 approved:{aline:['P1','P2','P4'],eric:['P2']},strict_isolation:true,files:files.map(row=>({...row,path:asset(row.path)})),
};
const output=join(directory,'openface-native-journey.json');
await writeFile(output,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
process.stdout.write(JSON.stringify({manifest:output,files:files.length,graph_pairs:6,approved_pairs:4,contains_credentials:false})+'\n');
