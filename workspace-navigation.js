(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.NotejectWorkspaceNavigation=api;
})(typeof window==='undefined'?globalThis:window,function(){
  'use strict';
  const LIMIT=200;
  const kinds=new Set(['note','document','board']);
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  function normalize(value,data={}){
    const original=object(value),result={...original,version:1};
    for(const field of ['projects','collections','customTemplates'])result[field]=(Array.isArray(original[field])?original[field]:[]).filter(item=>item&&typeof item==='object'&&!Array.isArray(item)).map(item=>({...item}));
    result.taskMeta={...object(original.taskMeta)};
    const seed=Array.isArray(original.history)?original.history:[...(data.notes||[]).map(item=>({kind:'note',id:item.id,at:item.lastOpened})),...(data.docs||[]).map(item=>({kind:'document',id:item.id,at:item.lastOpened})),...(data.boards||[]).map(item=>({kind:'board',id:item.id,at:item.lastOpened}))];
    const ordered=seed.filter(item=>item&&kinds.has(item.kind)&&typeof item.id==='string'&&item.id&&Number.isFinite(Number(item.at))&&Number(item.at)>0).map(item=>({kind:item.kind,id:item.id,at:Number(item.at)})).sort((a,b)=>b.at-a.at);
    const seen=new Set();result.history=ordered.filter(item=>{const key=item.kind+':'+item.id;if(seen.has(key))return false;seen.add(key);return true}).slice(0,LIMIT);
    return result;
  }
  function resolve(data,kind,id){return(kind==='note'?data.notes:kind==='document'?data.docs:kind==='board'?data.boards:[])?.find(item=>item.id===id)||null;}
  function visit(data,kind,id,at=Date.now()){
    const item=resolve(data,kind,id);if(!item||!Number.isFinite(at)||at<=0)return false;
    if(!data.workspace||typeof data.workspace!=='object'||Array.isArray(data.workspace))data.workspace=normalize(null,data);
    if(!Array.isArray(data.workspace.history))data.workspace.history=[];
    data.workspace.history=[{kind,id,at},...data.workspace.history.filter(entry=>entry&&!(entry.kind===kind&&entry.id===id))].slice(0,LIMIT);
    item.lastOpened=at;return true;
  }
  function progressSnapshot(doc,state){
    const ratio=value=>Math.max(0,Math.min(1,Number(value)||0));
    if(doc.type==='pdf'&&Number(state.pages)>0){
      doc.readerPages=Math.max(1,Math.floor(Number(state.pages)));doc.readerPage=Math.max(1,Math.min(doc.readerPages,Math.floor(Number(state.page)||1)));doc.readerPageOffset=ratio(state.offset);
      doc.readerProgress=ratio((doc.readerPage-1+doc.readerPageOffset)/doc.readerPages);
    }else if(doc.type==='epub'&&Number(state.chapters)>0){
      doc.readerChapters=Math.max(1,Math.floor(Number(state.chapters)));doc.readerChapter=Math.max(0,Math.min(doc.readerChapters-1,Math.floor(Number(state.chapter)||0)));doc.readerChapterOffset=ratio(state.offset);doc.readerChapterTitle=String(state.chapterTitle||'');
      doc.readerProgress=ratio((doc.readerChapter+doc.readerChapterOffset)/doc.readerChapters);
    }else if(doc.type==='txt')doc.readerProgress=ratio(state.ratio);
    return doc;
  }
  function renameFolder(data,oldName,newName){
    if(!oldName||!newName||oldName===newName)return;
    for(const field of ['folders','noteFolders'])data[field]=[...new Set((data[field]||[]).map(folder=>folder===oldName?newName:folder))];
    for(const items of [data.notes,data.docs,data.boards])for(const item of items||[])if(item.folder===oldName)item.folder=newName;
    if(data.folderProjects&&data.folderProjects[oldName]){data.folderProjects[newName]=data.folderProjects[oldName];delete data.folderProjects[oldName];}
    const state=data.workspace||{};
    for(const project of state.projects||[])if(project.folder===oldName){project.folder=newName;if(project.name===oldName)project.name=newName;}
    for(const collection of state.collections||[])if(collection.folder===oldName)collection.folder=newName;
  }
  function removeFolder(data,name){
    if(!name||name==='Inbox')return;
    for(const field of ['folders','noteFolders'])data[field]=[...new Set(['Inbox',...(data[field]||[]).filter(folder=>folder!==name)])];
    for(const items of [data.notes,data.docs,data.boards])for(const item of items||[])if(item.folder===name)item.folder='Inbox';
    if(data.folderProjects)delete data.folderProjects[name];
    if(data.workspace){data.workspace.projects=(data.workspace.projects||[]).filter(project=>project.folder!==name);for(const collection of data.workspace.collections||[])if(collection.folder===name)collection.folder='Inbox';}
  }
  return {normalize,resolve,visit,progressSnapshot,renameFolder,removeFolder,LIMIT};
});
