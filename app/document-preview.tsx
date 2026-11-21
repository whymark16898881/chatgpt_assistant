'use client';
import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
type Original={id:string;filename:string};
type Content={kind:'image'|'pdf';url:string}|{kind:'text';text:string};
export default function DocumentPreview({document:original,onClose}:{document:Original;onClose:()=>void}){
 const [content,setContent]=useState<Content|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[zoom,setZoom]=useState(1),[retry,setRetry]=useState(0);
 const panel=useRef<HTMLElement>(null),closeRef=useRef(onClose);closeRef.current=onClose;
 useEffect(()=>{
  let active=true,objectUrl:string|undefined,timedOut=false;const controller=new AbortController(),timer=setTimeout(()=>{timedOut=true;controller.abort();},20000);
  setContent(null);setError('');setLoading(true);setZoom(1);
  void(async()=>{try{
   const r=await fetch('/api/documents/'+encodeURIComponent(original.id),{credentials:'same-origin',cache:'no-store',signal:controller.signal});
   if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(r.status===401?'登录已失效，请刷新页面后重新登录':d.error||'原件读取失败');}
   const blob=await r.blob();if(!active)return;const mime=blob.type.split(';')[0].toLowerCase();
   if(['image/jpeg','image/png','image/webp','image/gif','image/avif','image/bmp','application/pdf'].includes(mime)){
    objectUrl=URL.createObjectURL(blob);setContent({kind:mime==='application/pdf'?'pdf':'image',url:objectUrl});
   }else if((mime.startsWith('text/')||mime==='application/json')&&blob.size<=256*1024){const text=await blob.text();if(active)setContent({kind:'text',text});}
   else throw new Error('此格式暂不支持页内预览，可下载原件查看');
  }catch(e){if(active)setError(timedOut?'读取原件超时，请重试':(e as Error).message);}finally{clearTimeout(timer);if(active)setLoading(false);}})();
  return()=>{active=false;clearTimeout(timer);controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
 },[original.id,retry]);
 useEffect(()=>{
  const previous=window.document.activeElement as HTMLElement|null,oldOverflow=window.document.body.style.overflow;window.document.body.style.overflow='hidden';panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
  function keydown(e:KeyboardEvent){if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeRef.current();}else if(e.key==='Tab'){
   const nodes=panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],iframe,[tabindex="0"]');if(!nodes?.length)return;const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&window.document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&window.document.activeElement===last){e.preventDefault();first.focus();}
  }}
  window.document.addEventListener('keydown',keydown,true);return()=>{window.document.removeEventListener('keydown',keydown,true);window.document.body.style.overflow=oldOverflow;requestAnimationFrame(()=>{if(previous?.isConnected)previous.focus();});};
 },[]);
 return createPortal(<div className="modal-backdrop document-preview-backdrop" onClick={e=>{if(e.target===e.currentTarget)onClose();}}><section ref={panel} className="document-preview" role="dialog" aria-modal="true" aria-labelledby="original-preview-title"><header><div><h2 id="original-preview-title">原件预览</h2><small>{original.filename}</small></div><button type="button" className="secondary" aria-label="关闭原件预览" onClick={onClose}>关闭 ×</button></header><div className="preview-tools">{content?.kind==='image'&&<><button type="button" className="secondary" aria-label="缩小原图" disabled={zoom<=0.25} onClick={()=>setZoom(v=>Math.max(0.25,v-0.25))}>−</button><span aria-label="原图显示比例">{Math.round(zoom*100)}%</span><button type="button" className="secondary" aria-label="放大原图" disabled={zoom>=3} onClick={()=>setZoom(v=>Math.min(3,v+0.25))}>＋</button><button type="button" className="text-button" onClick={()=>setZoom(1)}>适应宽度</button></>}<a href={'/api/documents/'+encodeURIComponent(original.id)} download={original.filename}>下载原件</a></div><div className="preview-canvas" tabIndex={0} aria-label="原件内容">{loading&&<p role="status">正在读取原件…</p>}{error&&<div><p className="error" role="alert">{error}</p><button type="button" className="secondary" onClick={()=>setRetry(v=>v+1)}>重新读取</button></div>}{content?.kind==='image'&&<img src={content.url} alt={original.filename} style={{width:`${zoom*100}%`}} onError={()=>setError('图片无法显示，可重试或下载原件')}/>} {content?.kind==='pdf'&&<iframe src={content.url} title={'PDF原件 '+original.filename} referrerPolicy="no-referrer"/>}{content?.kind==='text'&&<pre>{content.text}</pre>}</div><small className="preview-hint">预览不会修改账目；关闭后可继续填写，未保存内容保留。按 Esc 可关闭。</small></section></div>,window.document.body);
}
