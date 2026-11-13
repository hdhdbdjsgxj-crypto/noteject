/* One command order and vocabulary for native PDF/DjVu and reflowable Readers. */
(() => {
  'use strict';
  const workflow='Select text and choose Save passage. Choose a Notes folder, add your thoughts and an optional Board, then save. Open Notes & Passages and choose Edit in Notes. Edit the note, add text, links or images, and Save. Use Return to passage to resume reading. The original source location stays linked.';
  const items=[
    ['contents','contents','Contents'],['find','find','Find in document'],['saved','notes','Notes & Passages'],
    ['add-to-board','notes','Add saved passages to Board'],['bookmark','bookmark','Bookmark'],['save-passage','save','Save passage'],
    ['extend-passage','save','Extend selection'],['save-image','save','Save image'],['comment','save','Add comment here'],
    ['view','view','View & reading'],['help','notes','How to edit passages in Notes']
  ].map(([id,icon,label])=>Object.freeze({id,icon,label}));
  function forType(type){return items.filter(item=>item.id!=='save-image'||['pdf','djvu','epub','txt'].includes(type)).filter(item=>item.id!=='extend-passage'||['pdf','djvu','epub'].includes(type)).map(item=>({...item,label:item.id==='extend-passage'?(type==='epub'?'Extend to next chapter':'Select through page…'):item.label}));}
  function showHelp(){
    const dialog=document.createElement('dialog');dialog.className='ux-dialog reader-workflow-help';dialog.setAttribute('aria-label','How to edit passages in Notes');
    const title=document.createElement('h2');title.textContent='How to edit passages in Notes';
    const list=document.createElement('ol');for(const step of ['Select text in the Reader and choose Save passage.','Choose the Notes folder, add your thoughts and an optional Board, then save.','Open Notes & Passages and choose Edit in Notes.','Edit the note, add text, links or images, and tap Save.','Use Return to passage to resume reading. Your original source location stays linked.']){const row=document.createElement('li');row.textContent=step;list.append(row);}
    const close=document.createElement('button');close.type='button';close.textContent='Close';close.onclick=()=>dialog.close();dialog.append(title,list,close);dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal();
  }
  window.NotejectReaderMenu=Object.freeze({forType,workflow,showHelp});
})();
