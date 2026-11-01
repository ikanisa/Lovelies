/** Short-lived unsent notes, optionally persisted as ciphertext through a
 * generation-fenced browser store. This is separate from submitted operations;
 * confirmations are never retained and restoring a note cannot send a review. */
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-58][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const forms=new Set(['live-review-form','live-session-form','live-guardian-form','live-adult-form','live-queue-repair-form']);
const names=new Set(['reason','decision','evidence_method','evidence_reference']);
function identity(scope) {
  if(!scope||!uuid(scope.accountId)||!(uuid(scope.recordId)||scope.form==='live-queue-repair-form'&&/^[0-9a-f]{64}$/.test(scope.recordId??''))||!forms.has(scope.form)||
      typeof scope.version!=='string'||scope.version.length>2048||
      typeof scope.target!=='string'||scope.target.length>100)throw new Error('invalid_draft_scope');
  return JSON.stringify([scope.accountId,scope.recordId,scope.form,scope.target]);
}
function fieldsOnly(fields) {
  const result={};
  for(const [name,value] of Object.entries(fields??{})) {
    if(!names.has(name)||typeof value!=='string'||value.length>1000)throw new Error('invalid_draft_fields');
    result[name]=value;
  }
  return result;
}
const additionalData=scope=>new TextEncoder().encode(JSON.stringify([scope.accountId,scope.recordId,scope.form,scope.target,scope.version]));
export class ReviewDrafts {
  constructor({crypto=globalThis.crypto,now=Date.now,ttlMs=30*60*1000,maxEntries=8,storage=null}={}) {
    this.crypto=crypto;this.now=now;this.ttl=ttlMs;this.limit=maxEntries;this.entries=new Map();this.epoch=0;this.key=null;this.account=null;this.storage=storage;this.hydrated=null;this.pending=Promise.resolve();
  }
  bind(account) {
    if(this.account&&this.account!==account)this.discard();
    this.account=account;
  }
  async hydrate(account) {
    this.bind(account);if(!this.storage||this.hydrated===account)return;
    if(this.hydrating?.account===account&&this.hydrating.epoch===this.epoch)return this.hydrating.work;
    const epoch=this.epoch;
    const work=(async()=>{const state=await this.storage.load(account);
    if(epoch!==this.epoch||this.account!==account)return;
    const entries=new Map();
    for(const entry of state.entries){
      const id=identity(entry.scope);
      if(entry.scope.accountId!==account||!Number.isSafeInteger(entry.expires)||entry.expires>this.now()+this.ttl||
        !(entry.iv instanceof Uint8Array)||entry.iv.length!==12||!(entry.sealed instanceof Uint8Array)||entry.sealed.length>16384)throw new Error('draft_storage_invalid');
      if(entry.expires>this.now())entries.set(id,entry);
    }
    if(entries.size&&!state.key)throw new Error('draft_storage_invalid');
    this.entries=entries;this.key=state.key?Promise.resolve(state.key):null;this.hydrated=account;
    if(entries.size!==state.entries.length)await this.persist();
    })();
    this.hydrating={account,epoch,work};
    try{await work;}finally{if(this.hydrating?.work===work)this.hydrating=null;}
  }
  async persist() {
    if(!this.storage)return;
    const epoch=this.epoch,account=this.account,key=this.key?await this.key:null;
    if(epoch!==this.epoch||!account)return;
    const work=this.storage.write(account,key,[...this.entries.values()].filter(entry=>entry.sealed&&entry.expires>this.now()));
    this.pending=work;await work;
  }
  prune() {
    for(const [id,entry] of this.entries)if(entry.expires<=this.now()){entry.sealed?.fill(0);this.entries.delete(id);}
  }
  async save(scope,fields) {
    const context={...scope},id=identity(context),values=fieldsOnly(fields);
    this.bind(context.accountId);const epoch=this.epoch;
    await this.hydrate(context.accountId);
    if(epoch!==this.epoch||this.account!==context.accountId)return false;
    this.prune();
    if(!Object.values(values).some(Boolean)){await this.remove(context);return false;}
    if(!this.entries.has(id)&&this.entries.size>=this.limit)throw new Error('draft_limit_reached');
    if(!this.crypto?.subtle)throw new Error('draft_protection_unavailable');
    const entry={scope:context,expires:this.now()+this.ttl,sealed:null,iv:this.crypto.getRandomValues(new Uint8Array(12))};
    this.entries.get(id)?.sealed?.fill(0);this.entries.set(id,entry);
    let key;
    try{key=await (this.key??=this.crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']));}
    catch(error){if(this.entries.get(id)===entry)this.entries.delete(id);throw error;}
    if(epoch!==this.epoch||this.entries.get(id)!==entry)return false;
    const plain=new TextEncoder().encode(JSON.stringify(values));
    try {
      const sealed=new Uint8Array(await this.crypto.subtle.encrypt({name:'AES-GCM',iv:entry.iv,additionalData:additionalData(entry.scope)},key,plain));
      if(epoch!==this.epoch||this.entries.get(id)!==entry){sealed.fill(0);return false;}
      entry.sealed=sealed;await this.persist();return epoch===this.epoch&&this.entries.get(id)===entry;
    } catch(error) {if(this.entries.get(id)===entry)this.entries.delete(id);throw error;}
    finally {plain.fill(0);}
  }
  available(scope) {
    const id=identity(scope);if(this.account!==scope.accountId)return false;this.prune();const entry=this.entries.get(id);
    try{if(this.storage&&!this.storage.current())return false;}catch{return false;}
    if(entry&&entry.scope.version!==scope.version){this.remove(scope);return false;}
    return !!entry?.sealed;
  }
  async restore(scope) {
    const context={...scope},id=identity(context);
    this.bind(context.accountId);const epoch=this.epoch;
    await this.hydrate(context.accountId);
    if(epoch!==this.epoch||this.account!==context.accountId||!this.available(context))return null;
    const entry=this.entries.get(id),key=await this.key;
    if(epoch!==this.epoch||this.entries.get(id)!==entry)return null;
    const plain=new Uint8Array(await this.crypto.subtle.decrypt({name:'AES-GCM',iv:entry.iv,additionalData:additionalData(context)},key,entry.sealed));
    try {
      if(epoch!==this.epoch||this.entries.get(id)!==entry||entry.expires<=this.now()||this.storage&&!this.storage.current())return null;
      return fieldsOnly(JSON.parse(new TextDecoder().decode(plain)));
    } finally {plain.fill(0);}
  }
  remove(scope) {const id=identity(scope);this.entries.get(id)?.sealed?.fill(0);this.entries.delete(id);if(this.storage){this.pending=this.persist();this.pending.catch(()=>{});}return this.pending;}
  suspend() {this.epoch++;for(const entry of this.entries.values())entry.sealed?.fill(0);this.entries.clear();this.key=null;this.account=null;this.hydrated=null;}
  discard() {this.suspend();if(this.storage){try{this.pending=this.storage.clear();}catch(error){this.pending=Promise.reject(error);}this.pending.catch(()=>{});}return this.pending;}
}
