/** Browser-local encrypted draft storage. A synchronous opaque generation
 * tombstone prevents an old tab or interrupted logout from reviving ciphertext.
 * No notes, account IDs, credentials or decisions enter localStorage. */
const fail=()=>{throw new Error('draft_storage_changed');};
export class ReviewDraftStore {
  constructor(base,{indexedDB=globalThis.indexedDB,localStorage=globalThis.localStorage,crypto=globalThis.crypto}={}) {
    this.base=base;this.indexedDB=indexedDB;this.markers=localStorage;this.crypto=crypto;
    this.markerKey='lovelies-review-draft-generation-v1:'+base;this.generation=null;this.revision=0;this.account=null;this.tail=Promise.resolve();
  }
  marker(create=false) {
    if(!this.markers)throw new Error('draft_storage_unavailable');
    let value=this.markers.getItem(this.markerKey);
    if(!value&&create){value=this.crypto.randomUUID();this.markers.setItem(this.markerKey,value);}
    return value;
  }
  current(){return !!this.generation&&this.marker()===this.generation;}
  async database(){
    if(!this.indexedDB)throw new Error('draft_storage_unavailable');
    if(!this.db)this.db=await new Promise((resolve,reject)=>{
      const request=this.indexedDB.open('lovelies-review-drafts-v1',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('drafts');
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('draft_storage_blocked'));
    });return this.db;
  }
  async load(account) {
    await this.tail.catch(()=>{});let generation=this.marker(true);const db=await this.database();
    const record=await new Promise((resolve,reject)=>{const request=db.transaction('drafts').objectStore('drafts').get(this.base);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    if(this.marker()!==generation)return fail();
    if(record?.generation===generation&&record.account&&record.account!==account){generation=this.crypto.randomUUID();this.markers.setItem(this.markerKey,generation);}
    this.generation=generation;this.account=account;this.revision=record?.revision??0;
    if(record?.generation!==generation||record.account!==account)return {key:null,entries:[]};
    if(record.key&&(record.key.extractable||record.key.type!=='secret'||record.key.algorithm?.name!=='AES-GCM')||!Array.isArray(record.entries)||record.entries.length>8)throw new Error('draft_storage_invalid');
    return {key:record.key,entries:record.entries};
  }
  write(account,key,entries) {
    const generation=this.generation,snapshot=structuredClone(entries);
    const work=this.tail.catch(()=>{}).then(async()=>{
      if(!generation||this.marker()!==generation||account!==this.account)return fail();
      const db=await this.database(),expected=this.revision;
      await new Promise((resolve,reject)=>{
        const tx=db.transaction('drafts','readwrite',{durability:'strict'}),store=tx.objectStore('drafts');let conflict=false;
        const get=store.get(this.base);get.onsuccess=()=>{
          if(this.marker()!==generation||(get.result?.revision??0)!==expected){conflict=true;tx.abort();return;}
          store.put({generation,account,key,entries:snapshot,revision:expected+1},this.base);
        };
        tx.oncomplete=()=>{this.revision=expected+1;resolve();};tx.onabort=()=>reject(new Error(conflict?'draft_storage_changed':'draft_storage_failed'));tx.onerror=()=>{};
      });
      if(this.marker()!==generation)return fail();
    });this.tail=work;return work;
  }
  clear() {
    // This runs before the first await. Even if IndexedDB cleanup is interrupted,
    // old ciphertext/key records have a different generation and cannot load.
    const generation=this.crypto.randomUUID();this.markers.setItem(this.markerKey,generation);this.generation=null;this.account=null;
    const work=this.tail.catch(()=>{}).then(async()=>{
      const db=await this.database();
      await new Promise((resolve,reject)=>{const tx=db.transaction('drafts','readwrite',{durability:'strict'}),store=tx.objectStore('drafts');
        const get=store.get(this.base);get.onsuccess=()=>{if(this.marker()===generation)store.put({generation,account:null,key:null,entries:[],revision:(get.result?.revision??0)+1},this.base);};
        tx.oncomplete=resolve;tx.onabort=()=>reject(new Error('draft_storage_failed'));tx.onerror=()=>{};
      });
    });this.tail=work;return work;
  }
}
