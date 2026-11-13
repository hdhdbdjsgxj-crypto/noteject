/* Search text and DOM highlights share the same normalization and UTF-16 offsets. */
(() => {
  'use strict';
  function index(source) {
    source=String(source||'');const chars=[],starts=[],ends=[];
    for(let at=0;at<source.length;){
      const start=at,point=source.codePointAt(at),raw=String.fromCodePoint(point);at+=raw.length;
      if(raw==='\u00ad')continue;
      if(/[-\u2010]/.test(raw)&&/^[ \t]*\r?\n\s*\p{L}/u.test(source.slice(at,at+80))&&start>0&&/\p{L}/u.test(source[start-1])){
        const gap=source.slice(at).match(/^[ \t]*\r?\n\s*/);at+=gap[0].length;continue;
      }
      for(const char of raw.normalize('NFKC').toLowerCase()){
        const value=/\s/u.test(char)?' ':char;
        if(value===' '&&chars.at(-1)===' '){ends[ends.length-1]=at;continue;}
        // A normalized code point may still be a UTF-16 pair.
        for(let unit=0;unit<value.length;unit++){chars.push(value[unit]);starts.push(start);ends.push(at);}
      }
    }
    return {text:chars.join(''),starts,ends};
  }
  function find(haystack,query,limit=5000){
    const needle=index(query).text.trim(),matches=[];if(!needle)return matches;
    for(let at=haystack.text.indexOf(needle);at>=0&&matches.length<limit;at=haystack.text.indexOf(needle,at+needle.length))
      matches.push({offset:haystack.starts[at],end:haystack.ends[at+needle.length-1]});
    return matches;
  }
  function dom(root){
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT|NodeFilter.SHOW_ELEMENT,{acceptNode:node=>node.parentElement?.closest('style,script,noscript,button,input,textarea')?NodeFilter.FILTER_REJECT:node.nodeType===3||node.nodeName==='BR'?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_SKIP});
    const segments=[];let source='',node,prior=null;
    while(node=walker.nextNode()){
      if(node.nodeName==='BR'){source+='\n';continue;}
      if(!node.nodeValue)continue;
      if(prior&&prior!==node.parentElement){
        if(root.classList.contains('pdf-text-layer'))source+=' ';
        else {const block=el=>el?.closest('p,div,li,h1,h2,h3,h4,h5,h6,section,article,blockquote,td,tr');if(block(prior)!==block(node.parentElement)||node.previousSibling?.nodeName==='BR')source+='\n';}
      }
      const start=source.length;source+=node.nodeValue;segments.push({node,start,end:source.length});prior=node.parentElement;
    }
    return {source,segments};
  }
  window.NotejectReaderTextSearch=Object.freeze({index,find,dom});
})();
