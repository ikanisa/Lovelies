// Explicitly invoked deployment operation. Defaults to a read-only inspection.
// Credentials come only from the process environment and are never printed.
const projectUrl=process.env.SUPABASE_URL??'https://ltqfplqevxztlswlzexn.supabase.co';
const project=new URL(projectUrl);
if(project.hostname!=='ltqfplqevxztlswlzexn.supabase.co'&&!['localhost','127.0.0.1'].includes(project.hostname))throw new Error('Unexpected Supabase project');
const secret=process.env.LOVELIES_STORAGE_SECRET??process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!secret)throw new Error('Provide a server-only Storage secret through the process environment');
const apply=process.argv.includes('--apply');
if(process.argv.slice(2).some(arg=>arg!=='--apply'))throw new Error('Only --apply is supported');
const headers={apikey:secret,'Content-Type':'application/json',...(secret.split('.').length===3?{Authorization:'Bearer '+secret}:{})};
for(const [id,types] of [['lovelies-photos',['image/jpeg','image/png','image/webp','application/octet-stream']],['lovelies-quarantine',['image/jpeg','image/png','image/webp']],['lovelies-privacy-exports',['application/json']]]){
 const read=await fetch(project.origin+'/storage/v1/bucket/'+id,{headers,redirect:'error'});
 if(read.status===404){
  if(!apply){console.log(id+': missing; requires --apply to create private bucket');continue;}
  const created=await fetch(project.origin+'/storage/v1/bucket',{method:'POST',headers,redirect:'error',body:JSON.stringify({id,name:id,public:false,file_size_limit:20971520,allowed_mime_types:types})});
  if(!created.ok)throw new Error(id+': bucket creation failed, HTTP '+created.status);
  await created.body?.cancel();console.log(id+': created private bucket');
 }else{
  if(!read.ok)throw new Error(id+': bucket inspection denied, HTTP '+read.status);
  const bucket=await read.json();if(bucket.public!==false)throw new Error(id+': existing bucket is public; manual review required');
  if(Number(bucket.file_size_limit)!==20971520||!Array.isArray(bucket.allowed_mime_types)||types.some(type=>!bucket.allowed_mime_types.includes(type)))throw new Error(id+': private bucket configuration differs; inspect before changing it');
  console.log(id+': private bucket configuration verified');
 }
}
