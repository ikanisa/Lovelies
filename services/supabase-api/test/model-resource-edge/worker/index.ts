import {runResourceProbe} from '../../model-resource-probe.ts';

addEventListener('beforeunload',event=>{
  const detail=(event as CustomEvent).detail;
  console.log(JSON.stringify({event:'resource_fixture_beforeunload',reason:typeof detail==='string'?detail:detail?.reason??null,memory:Deno.memoryUsage()}));
});
Deno.serve(async request=>{
  const url=new URL(request.url);
  if(url.pathname!=='/resource'||request.method!=='GET')return new Response(null,{status:404});
  return Response.json(await runResourceProbe(url.searchParams.get('case')==='over'?1:0));
});
