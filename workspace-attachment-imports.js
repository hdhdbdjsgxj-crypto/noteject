/* Publish imported attachment generations without overwriting the live workspace. */
(function(root){
  'use strict';
  function create({database,storage,workspace,key='noteject'}) {
    let recovering=null, active=null;
    const raw=()=>storage.getItem(key);
    const parse=value=>{try{return JSON.parse(value||'null')}catch{return null}};
    function transaction(db,names,write,run){return new Promise((resolve,reject)=>{
      const tx=db.transaction(names,write?'readwrite':'readonly');let value;
      tx.oncomplete=()=>resolve(value);tx.onerror=()=>reject(tx.error||Error('Attachment transaction failed'));tx.onabort=()=>reject(tx.error||Error('Attachment transaction cancelled'));
      run(tx,result=>{value=result});
    });}
    async function records(){const db=await database();return transaction(db,['imports'],false,(tx,done)=>{const request=tx.objectStore('imports').getAll();request.onsuccess=()=>done(request.result||[])});}
    async function discard(record){const db=await database();await transaction(db,['documents','imports'],true,tx=>{
      for(const value of record.stagedKeys||[])tx.objectStore('documents').delete(value);
      tx.objectStore('imports').delete(record.id);
    });}
    function recover(){if(!recovering)recovering=(async()=>{
      let removed=0;const current=parse(raw());
      for(const record of await records())if(record.state==='staging'){
        if(current?.attachmentImportId===record.id){record.state='committed';const db=await database();await transaction(db,['imports'],true,tx=>tx.objectStore('imports').put(record));}
        else{await discard(record);removed++;}
      }
      return removed;
    })().catch(error=>{recovering=null;throw error});return recovering;}
    async function begin(){await recover();if(active)throw Error('Another workspace import is still running.');
      const previousWorkspace=raw();
      const record={id:crypto.randomUUID(),created:Date.now(),state:'staging',previousWorkspace,stagedKeys:[]};
      // Reserve synchronously: another begin() can resume while IndexedDB awaits.
      active=record;
      try { const db=await database();await transaction(db,['imports'],true,tx=>tx.objectStore('imports').put(record));return record; }
      catch(error){if(active===record)active=null;throw error;}
    }
    async function stage(record,documentId,blob){if(active!==record)throw Error('The import is no longer active.');
      const blobKey='import:'+record.id+':'+documentId;
      if(!record.stagedKeys.includes(blobKey))record.stagedKeys.push(blobKey);
      const db=await database();await transaction(db,['documents','imports'],true,tx=>{
        tx.objectStore('documents').put(blob,blobKey);tx.objectStore('imports').put(record);
      });return blobKey;
    }
    async function checkpoint(record){if(active!==record)throw Error('The import is no longer active.');record.previousWorkspace=raw();const db=await database();await transaction(db,['imports'],true,tx=>tx.objectStore('imports').put(record));}
    async function commit(record){if(parse(raw())?.attachmentImportId!==record.id)throw Error('The imported workspace has not been saved.');
      try { record.state='committed';const db=await database();await transaction(db,['imports'],true,tx=>tx.objectStore('imports').put(record));
      // Retain the latest recovery snapshot; old original blobs remain safe. A
      // snapshot is metadata only, so the original files never need to be copied.
      const completed=(await records()).filter(item=>item.state==='committed').sort((a,b)=>b.created-a.created);
      for(const old of completed.slice(1))await transaction(db,['imports'],true,tx=>tx.objectStore('imports').delete(old.id));
      const protectedKeys=new Set();
      for(const value of [parse(raw()),parse(record.previousWorkspace)]) {
        for(const blobKey of Object.values(value?.attachmentKeys||{}))protectedKeys.add(blobKey);
        for(const doc of value?.docs||[])protectedKeys.add(doc.id);
      }
      // Only our generated keys are eligible for reclamation. Current files,
      // trash mappings, and the recovery generation remain protected.
      await transaction(db,['documents'],true,tx=>{
        const store=tx.objectStore('documents'),request=store.openKeyCursor();
        request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;const blobKey=cursor.primaryKey;if(typeof blobKey==='string'&&blobKey.startsWith('import:')&&!protectedKeys.has(blobKey))store.delete(blobKey);cursor.continue();};
      });
      } catch(error) { console.warn('Workspace published; import recovery housekeeping will retry.',error); return false; } finally { active=null; }
    }
    async function abort(record){if(!record)return;if(parse(raw())?.attachmentImportId===record.id){if(active===record)active=null;return;}
      await discard(record);if(active===record)active=null;
    }
    async function previous(){await recover();const current=parse(raw());return(await records()).filter(record=>(record.state==='committed'||current?.attachmentImportId===record.id)&&parse(record.previousWorkspace)?.boards?.length).sort((a,b)=>b.created-a.created)[0]||null;}
    function resolve(documentId){const map=workspace()?.attachmentKeys;return map&&Object.hasOwn(map,documentId)&&typeof map[documentId]==='string'?map[documentId]:documentId;}
    function references(value,exceptId){
      const notes=[...(value?.notes||[]),...(value?.trash||[]).filter(item=>item.type==='note').map(item=>item.payload?.item).filter(Boolean)];
      const documents=[...(value?.docs||[]),...(value?.trash||[]).filter(item=>item.type==='document').map(item=>item.payload?.item).filter(Boolean),...notes.flatMap(note=>Array.isArray(note.mediaAssets)?note.mediaAssets:[])];
      return documents.filter(doc=>doc.id!==exceptId).map(doc=>value?.attachmentKeys?.[doc.id]||doc.id);
    }
    async function remove(documentId){
      if(!documentId)return false;
      await recover();
      const blobKey=resolve(documentId);
      // A permanent deletion from the current workspace must not damage a
      // previous workspace (including Trash) that still owns the same bytes.
      const protectedKeys=new Set(references(workspace(),documentId));
      for(const record of await records())for(const value of references(parse(record.previousWorkspace)))protectedKeys.add(value);
      if(protectedKeys.has(blobKey))return false;
      const db=await database();await transaction(db,['documents'],true,tx=>tx.objectStore('documents').delete(blobKey));
      return true;
    }
    return{recover,begin,stage,checkpoint,commit,abort,previous,resolve,remove};
  }
  root.NotejectAttachmentImports=Object.freeze({create});
})(typeof window==='undefined'?globalThis:window);
