#!/usr/bin/env node
/** Prepare a disabled Supabase inference host. No upload, image push or secret
 * mutation occurs here. Serving requires a separately qualified release. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,relative,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2);
assert(args.length===2&&args[0]==='--output','Usage: node scripts/prepare-inference-host.mjs --output <NEW-directory>');
const directory=resolve(args[1]);
const templatePath=join(root,'services/ml-container-worker/wrangler.supabase.jsonc');
const template=await readFile(templatePath,'utf8');
const configuration=JSON.parse(template.replace(/^\s*\/\/.*$/gm,''));
assert.equal(configuration.name,'lovelies-supabase-inference');
assert.equal(configuration.vars.INFERENCE_SERVING_ENABLED,'false');
assert.equal(configuration.vars.INFERENCE_RELEASE_RECEIPT_SHA256,'');
assert.equal(configuration.vars.INFERENCE_IMAGE_URI,'');
assert.equal(configuration.containers.length,1);
assert.equal(configuration.containers[0].image,'__QUALIFIED_IMMUTABLE_CLOUDFLARE_IMAGE_URI_REQUIRED__');
assert.deepEqual(configuration.containers[0].constraints,{jurisdiction:'eu',regions:['WEUR']});
assert.equal(configuration.containers[0].max_instances,1);
assert(!configuration.services&&!configuration.r2_buckets&&!configuration.routes);

// This first deployment registers the reviewed Worker and its own DO class.
// It creates no Container application, starts no instance and selects no image.
// Preserve the separate container template for a later qualified-image deploy.
configuration.account_id='2209b915a85b1c11cee79b7806c6e73b';
configuration.main=join(root,'services/ml-container-worker/src/supabase-inference.ts');
configuration.$schema=join(root,'services/ml-container-worker/node_modules/wrangler/config-schema.json');
configuration.containers=[];
const bytes=Buffer.from(JSON.stringify(configuration,null,2)+'\n');
const digest=data=>createHash('sha256').update(data).digest('hex');
const sources=[];
for(const name of ['scripts/prepare-inference-host.mjs','services/ml-container-worker/src/supabase-inference.ts',
  'services/ml-container-worker/wrangler.supabase.jsonc','services/ml-container-worker/package.json']){
  const contents=await readFile(join(root,name));sources.push({path:name,bytes:contents.length,sha256:digest(contents)});
}
await mkdir(directory,{recursive:false,mode:0o700});
await writeFile(join(directory,'wrangler.disabled.json'),bytes,{mode:0o600,flag:'wx'});
const receipt={schema:'lovelies-disabled-inference-host-preparation-v1',created_at:new Date().toISOString(),
  status:'prepared_disabled',provider:'Cloudflare Containers',account_id:configuration.account_id,
  worker:configuration.name,selected_architecture:'linux/amd64',selected_jurisdiction:'eu',selected_region:'WEUR',
  configuration:{path:relative(root,join(directory,'wrangler.disabled.json')),bytes:bytes.length,sha256:digest(bytes)},
  source:sources,serving_enabled:false,container_application_created:false,image_selected:false,
  deployment_performed:false,secrets_written:false,
  activation_requires:['Accepted immutable consumer image and artifact-specific security disposition',
    'Faithful native x86 qualification including every canonical glibc fixture',
    'Exact loaded-model/engine readiness and authenticated private HTTP checks',
    'Immutable Cloudflare registry manifest URI bound to a reviewed release receipt',
    'Separate configured server-only credential and Supabase/scheduler cutover']};
await writeFile(join(directory,'preparation.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify({status:receipt.status,configuration:receipt.configuration.path,serving_enabled:false}));
