import { pathToFileURL } from 'node:url';
import { handleRequest,errorResponse } from './journal.mjs';
import { operationRoute,handleOperationRequest } from './operations.mjs';
import { inventoryRoute,authenticateInventoryRoute,handleInventoryRequest } from './inventory.mjs';
import { connectCustodyDatabase,createPostgresStorage } from './postgres-storage.mjs';
import { createPrivateServer } from './private-server.mjs';

export function journalHandler(storage,env){
  return async request=>{
    try{
      // Bootstrap is never available with the ordinary application credential.
      const bootstrap=new URL(request.url).pathname==='/v1/control/bootstrap';
      if(bootstrap&&(typeof env.RESTORE_JOURNAL_BOOTSTRAP_TOKEN!=='string'||env.RESTORE_JOURNAL_BOOTSTRAP_TOKEN===env.RESTORE_JOURNAL_TOKEN))throw new Error('journal_bootstrap_unavailable');
      const authorizationEnv=bootstrap?{...env,RESTORE_JOURNAL_TOKEN:env.RESTORE_JOURNAL_BOOTSTRAP_TOKEN}:env;
      await authenticateInventoryRoute(request,authorizationEnv);
      return await (inventoryRoute(request)?handleInventoryRequest(request,authorizationEnv,storage):
        operationRoute(request)?handleOperationRequest(request,authorizationEnv,storage):handleRequest(request,authorizationEnv,storage));
    }catch(error){return errorResponse(error);}
  };
}
export async function start(env=process.env){
  const database=await connectCustodyDatabase(env);
  try{
    const storage=createPostgresStorage(database,'restore_journal');await storage.health();
    const listener=await createPrivateServer({handle:journalHandler(storage,env),storage,env,service:'restore-journal'});
    return {...listener,close:async()=>{await listener.close();await database.close();}};
  }catch(error){await database.close();throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  start().then(({close})=>{process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());}).catch(()=>{console.error('Restore journal startup failed; verify private custody configuration.');process.exitCode=1;});
}
