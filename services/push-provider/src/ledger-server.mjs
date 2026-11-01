import { pathToFileURL } from 'node:url';
import { handleLedgerRequest } from './durable-ledger.mjs';
import { connectCustodyDatabase,createPostgresStorage } from '../../restore-journal/src/postgres-storage.mjs';
import { createPrivateServer } from '../../restore-journal/src/private-server.mjs';

export async function startLedger(env=process.env){
  const database=await connectCustodyDatabase(env);
  try{
    const storage=createPostgresStorage(database,'push_receipts');await storage.health();
    const listener=await createPrivateServer({handle:request=>handleLedgerRequest(request,env,storage),storage,env,service:'push-ledger'});
    return {...listener,close:async()=>{await listener.close();await database.close();}};
  }catch(error){await database.close();throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  startLedger().then(({close})=>{process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());}).catch(()=>{console.error('Push ledger startup failed; verify private custody configuration.');process.exitCode=1;});
}
