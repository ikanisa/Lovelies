#!/usr/bin/env node
/** Renew private leaf certificates under the existing CA; never rotate data keys. */
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID,X509Certificate} from 'node:crypto';
import {args,runtime,command,compose,writeReceipt,withOperationLock} from './local-supabase-common.mjs';
const options=args(process.argv.slice(2),['--runtime','--execute','--receipt'],['--execute']);
(async()=>{
 if(!options['--execute']||!options['--receipt'])throw Error('explicit_execute_and_receipt_required');const r=await runtime(options['--runtime']),tls=path.join(r.directory,'tls'),stage=path.join(tls,'renewal-'+randomUUID());
 return withOperationLock(r,'renew-private-certificates',async()=>{
 await fs.mkdir(stage,{mode:0o700});const ca=new X509Certificate(await fs.readFile(path.join(tls,'ca.crt')));
 if(Date.parse(ca.validTo)<Date.now()+120*86400000)throw Error('ca_rotation_requires_separate_dual_trust_procedure');
 const services=['restore-journal','push-ledger','ml-proxy'];
 for(const service of services){
  const leaf=path.join(stage,service);await command('openssl',['req','-newkey','rsa:3072','-nodes','-keyout',leaf+'.key','-out',leaf+'.csr','-subj','/CN='+service]);await fs.chmod(leaf+'.key',0o600);
  await fs.writeFile(leaf+'.ext','subjectAltName=DNS:'+service+'\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n',{flag:'wx',mode:0o600});
  await command('openssl',['x509','-req','-in',leaf+'.csr','-CA',path.join(tls,'ca.crt'),'-CAkey',path.join(tls,'ca.key'),'-CAcreateserial','-out',leaf+'.crt','-days','90','-sha256','-extfile',leaf+'.ext']);
  const cert=new X509Certificate(await fs.readFile(leaf+'.crt'));if(!cert.verify(ca.publicKey)||!cert.checkHost(service))throw Error('renewed_certificate_invalid');
 }
 // Keep protected previous leaves for an explicit rollback if a restart fails.
 for(const service of services)for(const extension of ['key','crt']){
  const current=path.join(tls,service+'.'+extension);await fs.copyFile(current,path.join(stage,service+'.previous.'+extension),constants.COPYFILE_EXCL);
  await fs.rename(path.join(stage,service+'.'+extension),current);
 }
 await compose(r,'custody',['up','-d','--force-recreate','--wait','restore-journal','push-ledger']);
 const running=(await compose(r,'application',['--profile','inference','ps','-q','ml-proxy'])).stdout.toString().trim();
 if(running)await compose(r,'application',['--profile','inference','up','-d','--force-recreate','ml-proxy']);
 const receipt={protocol:'lovelies-private-certificate-renewal-v1',observed_at:new Date().toISOString(),status:'leaf_certificates_renewed',services,ca_replaced:false,data_encryption_keys_replaced:false};
 await writeReceipt(options['--receipt'],receipt);console.log(JSON.stringify(receipt,null,2));
 });
})().catch(()=>{console.error('Certificate renewal did not complete. Protected previous leaves remain in the renewal directory; inspect health before resuming traffic. No data encryption key changed.');process.exitCode=1;});
