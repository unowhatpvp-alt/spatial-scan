let opening;
function db(){return opening||=new Promise((resolve,reject)=>{if(!('indexedDB'in window)){reject(new Error('Local storage is unavailable in this browser.'));return;}const request=indexedDB.open('spatial-scan',1);request.onupgradeneeded=()=>request.result.createObjectStore('models',{keyPath:'id'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>{opening=null;reject(request.error);};request.onblocked=()=>reject(new Error('Close other Spatial Scan tabs to use local storage.'));});}
async function transaction(mode,action){const database=await db();return new Promise((resolve,reject)=>{const tx=database.transaction('models',mode);let request;try{request=action(tx.objectStore('models'));}catch(e){reject(e);return;}tx.oncomplete=()=>resolve(request.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Local storage transaction was cancelled.'));});}
export const listModels=()=>transaction('readonly',store=>store.getAll()).then(items=>items.sort((a,b)=>b.created-a.created));
export const putModel=entry=>transaction('readwrite',store=>store.put(entry));
export const deleteModel=id=>transaction('readwrite',store=>store.delete(id));
