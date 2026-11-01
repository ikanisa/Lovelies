const origin=process.env.CUSTODY_SERVICE_ORIGIN;
try{
 const response=await fetch(origin+'/healthz',{headers:{authorization:'Bearer '+process.env.CUSTODY_HEALTH_TOKEN},redirect:'error',signal:AbortSignal.timeout(5000)});
 const value=await response.json();
 if(response.status!==200||value.status!=='ok'||value.schema_version!==1)throw Error();
}catch{process.exitCode=1;}
