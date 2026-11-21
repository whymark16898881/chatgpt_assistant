// Reads archived PDF originals: real text layer when present, rendered page images for scans.
// Never invents content; pages that cannot be read are reported explicitly.
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
export const PDF_MIME='application/pdf';
export const isPdf=mime=>mime===PDF_MIME;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const pdfRoot=()=>path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
const asset=name=>pathToFileURL(path.join(pdfRoot(),name)+path.sep).href;
let library,renderer;
const pdfjs=async()=>library??=await import('pdfjs-dist/legacy/build/pdf.mjs');
// Rasterizing scans needs the optional native canvas; missing it is reported, never silently skipped.
const canvas=async()=>renderer??=await import('@napi-rs/canvas').catch(()=>null);
export const DEFAULTS={maxTextPages:40,maxImagePages:3,textBudget:40000,imageWidth:1500,imageQuality:72,minTextChars:20};

// Keeps visual columns readable: statement amounts stay under their own heading instead of collapsing into one run.
function layoutLines(items,pageWidth,columns=110){
 const scale=columns/Math.max(1,pageWidth);
 const entries=[];
 for(const item of items){
  if(typeof item.str!=='string'||!item.str.trim())continue;
  const height=Math.abs(item.height)||Math.abs(item.transform[3])||10;
  entries.push({x:item.transform[4],y:item.transform[5],width:item.width||0,height,str:item.str});
 }
 entries.sort((a,b)=>b.y-a.y||a.x-b.x);
 const lines=[];
 for(const entry of entries){
  const last=lines.at(-1);
  if(last&&Math.abs(last.y-entry.y)<=Math.max(1.5,entry.height*0.4))last.items.push(entry);
  else lines.push({y:entry.y,items:[entry]});
 }
 return lines.map(line=>{
  let text='',end=null;
  for(const item of line.items.sort((a,b)=>a.x-b.x)){
   const separated=end!==null&&item.x-end>item.height*0.12;
   text=text.padEnd(Math.max(Math.round(item.x*scale),text.length+(separated&&text?1:0)),' ')+item.str;
   end=item.x+item.width;
  }
  return text.slice(0,400).replace(/\s+$/,'');
 }).filter(line=>line.trim());
}
// Kangxi radicals and full-width forms come out of some producers' ToUnicode maps; NFKC restores the real characters.
const clean=text=>text.normalize('NFKC').replace(/\u0000/g,'').replace(/[ \t]+\n/g,'\n').replace(/^\n+|\s+$/g,'');

async function renderPage(page,{imageWidth,imageQuality}){
 const lib=await canvas();
 if(!lib)return{unavailable:'renderer_missing'};
 const base=page.getViewport({scale:1});
 const viewport=page.getViewport({scale:Math.min(2,Math.max(0.2,imageWidth/base.width))});
 const width=Math.ceil(viewport.width),height=Math.ceil(viewport.height);
 if(width*height>40e6)return{unavailable:'page_too_large'};
 const surface=lib.createCanvas(width,height),context=surface.getContext('2d');
 context.fillStyle='#ffffff';context.fillRect(0,0,width,height);
 try{await page.render({canvasContext:context,viewport,canvas:surface}).promise;}catch{return{unavailable:'render_failed'};}
 return{mime:'image/jpeg',bytes:await surface.encode('jpeg',imageQuality),width,height};
}

async function open(bytes){
 const lib=await pdfjs();
 const task=lib.getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,standardFontDataUrl:asset('standard_fonts'),cMapUrl:asset('cmaps'),cMapPacked:true,iccUrl:asset('iccs'),wasmUrl:asset('wasm'),verbosity:0});
 try{return{task,document:await task.promise};}
 catch(e){
  void task.destroy().catch(()=>{});
  if(e?.name==='PasswordException')fail('PDF_PASSWORD_REQUIRED','此PDF已加密，服务器无法打开；请提供未加密版本或该页截图');
  fail('PDF_UNREADABLE','PDF无法解析，文件可能已损坏；请重新导出或改传截图');
 }
}

// Page count and whether a real text layer exists, without extracting everything.
export async function pdfOverview(bytes,{probePages=3}={}){
 const {task,document}=await open(bytes);
 try{
  let textChars=0;const probed=Math.min(document.numPages,probePages);
  for(let n=1;n<=probed;n++){const page=await document.getPage(n);textChars+=clean(layoutLines((await page.getTextContent()).items,page.getViewport({scale:1}).width).join('\n')).length;page.cleanup();}
  const has_text_layer=textChars>=DEFAULTS.minTextChars;
  return{page_count:document.numPages,probed_pages:probed,has_text_layer,kind:has_text_layer?'text_layer':'scanned_or_image_only',
   read_hint:has_text_layer?'用cfo_read_document按页读取真实文本后再提交候选交易':'前几页没有文本层，cfo_read_document会返回渲染后的页面图片供识别'};
 }finally{await task.destroy().catch(()=>{});}
}

export async function readPdf(bytes,{pages,maxTextPages=DEFAULTS.maxTextPages,maxImagePages=DEFAULTS.maxImagePages,textBudget=DEFAULTS.textBudget,imageWidth=DEFAULTS.imageWidth,imageQuality=DEFAULTS.imageQuality}={}){
 const {task,document}=await open(bytes);
 try{
  const count=document.numPages;
  const requested=pages?.length?[...new Set(pages)].sort((a,b)=>a-b):null;
  if(requested&&requested.some(n=>n>count))fail('PDF_PAGE_OUT_OF_RANGE',`此PDF共${count}页，请求的页码超出范围`);
  const order=requested||Array.from({length:count},(_,i)=>i+1);
  const read=[],skipped=[];let textChars=0,imageCount=0,textCount=0;
  for(const n of order){
   if(textCount>=maxTextPages&&imageCount>=maxImagePages){skipped.push(n);continue;}
   const page=await document.getPage(n);
   const text=clean(layoutLines((await page.getTextContent()).items,page.getViewport({scale:1}).width).join('\n'));
   if(text.length>=DEFAULTS.minTextChars){
    if(textCount>=maxTextPages||(textChars>0&&textChars+text.length>textBudget)){skipped.push(n);page.cleanup();continue;}
    textChars+=text.length;textCount++;read.push({page:n,kind:'text',text});
   }else if(imageCount>=maxImagePages){skipped.push(n);}
   else{
    imageCount++;const image=await renderPage(page,{imageWidth,imageQuality});
    read.push(image.unavailable?{page:n,kind:'unreadable',reason:image.unavailable,text}:{page:n,kind:'image',image,text});
   }
   page.cleanup();
  }
  return{page_count:count,pages:read,skipped_pages:skipped,text_page_count:textCount,
   image_page_count:read.filter(p=>p.kind==='image').length,unreadable_page_count:read.filter(p=>p.kind==='unreadable').length,
   truncated:skipped.length>0,text_chars:textChars};
 }finally{await task.destroy().catch(()=>{});}
}
