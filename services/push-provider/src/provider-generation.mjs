import {pathToFileURL} from 'node:url';
import {configuredProviders} from './server.mjs';
import {providerGeneration} from './providers.mjs';

/** Local inspection only. configuredProviders loads protected keys but neither
 * this function nor configuration() opens a provider/ledger network connection. */
export async function configuredProviderGeneration(env=process.env){
  const providers=await configuredProviders(env);
  try{return {protocol:'lovelies-push-provider-generation-v1',provider_generation:providerGeneration(providers),platforms:Object.keys(providers).sort(),
    sends_enabled:env.PUSH_PROVIDER_SEND_ENABLED==='true'};}
  finally{await Promise.allSettled(Object.values(providers).map(provider=>provider.close()));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  configuredProviderGeneration().then(value=>process.stdout.write(JSON.stringify(value)+'\n')).catch(()=>{
    process.stderr.write('Provider generation unavailable; verify actual protected provider files and configuration.\n');process.exitCode=1;
  });
}
