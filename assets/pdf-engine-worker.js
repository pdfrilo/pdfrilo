// PDF content removal runs off the UI thread. The original bytes stay in memory.
let mupdf=null;
async function loadMupdf(){if(!mupdf)mupdf=await import('./vendor/mupdf/mupdf.js');return mupdf;}
import './vendor/pdf-lib.min.js';
import {tryPreciseTextRemoval,tryPreciseImageRemoval} from './precise-text-removal.js';
let original = null;
const norm = s => s.normalize('NFKC').replace(/\s/g, '');
const close = (a,b,t=.12) => a.length===b.length && a.every((v,i)=>Math.abs(v-b[i])<=t);
const rect = q => [Math.min(q[0],q[2],q[4],q[6]),Math.min(q[1],q[3],q[5],q[7]),Math.max(q[0],q[2],q[4],q[6]),Math.max(q[1],q[3],q[5],q[7])];
function overlaps(a,b) {
  // Separating-axis test preserves isolation for angled text as well as rows.
  const p=[a.slice(0,2),a.slice(2,4),a.slice(6,8),a.slice(4,6)];
  const q=[b.slice(0,2),b.slice(2,4),b.slice(6,8),b.slice(4,6)];
  for(const poly of [p,q]) for(let i=0;i<4;i++) {
    const u=poly[i],v=poly[(i+1)%4], axis=[v[1]-u[1],u[0]-v[0]];
    const len=Math.hypot(...axis);if(!len)continue;
    const proj=t=>t.map(x=>(x[0]*axis[0]+x[1]*axis[1])/len);
    const x=proj(p),y=proj(q);
    if(Math.min(Math.max(...x),Math.max(...y))-Math.max(Math.min(...x),Math.min(...y))<=.015)return false;
  }
  return true;
}
function pageContent(page) {
  const chars=[],images=[];
  const text=page.toStructuredText('preserve-images,preserve-whitespace');
  try { text.walk({
    onChar(c,origin,font,size,quad,color) {chars.push({c,origin,size,quad});font.destroy();},
    onImageBlock(bounds,matrix,image) {
      let pix;
      try {
        pix=image.toPixmap();const data=pix.asPNG();let hash=2166136261;
        for(const b of data)hash=Math.imul(hash^b,16777619)>>>0;
        images.push({bounds,matrix,hash});
      } finally {pix?.destroy();image.destroy();}
    }
  }); } finally {text.destroy();}
  return {chars,images};
}
function assertPreserved(before,after,removedChars,removedImages) {
  const pool=after.chars.slice();
  for(let i=0;i<before.chars.length;i++) {
    const c=before.chars[i];
    const idx=pool.findIndex(x=>x.c===c.c && close(x.origin,c.origin) && Math.abs(x.size-c.size)<.12);
    if(removedChars.has(i)) {if(idx>=0 && c.c.trim())throw new Error('The selected text could not be completely removed.');}
    else if(idx<0) {if(c.c.trim())throw new Error('This selection overlaps other PDF text. No content was changed.');}
    else pool.splice(idx,1);
  }
  if(pool.some(x=>x.c.trim()))throw new Error('PDF text changed unexpectedly. No content was changed.');
  const remaining=after.images.slice();
  before.images.forEach((im,i)=>{
    const idx=remaining.findIndex(x=>x.hash===im.hash && close(x.bounds,im.bounds,.3) && close(x.matrix,im.matrix,.3));
    if(removedImages.has(i)) {if(idx>=0)throw new Error('The selected PDF image could not be removed.');}
    else {if(idx<0)throw new Error('This image overlaps another image. Safe removal is unavailable for this selection.');remaining.splice(idx,1);}
  });
  if(remaining.length)throw new Error('PDF graphics changed unexpectedly. No content was changed.');
}
function applyJob(pdf,job) {
  const page=pdf.loadPage(job.pageNumber-1);
  try {
    const bounds=page.getBounds(),sx=(bounds[2]-bounds[0])/job.width,sy=(bounds[3]-bounds[1])/job.height;
    const before=pageContent(page),removedChars=new Set(),removedImages=new Set();
    for(const item of job.items) {
      const quad=item.sourceRedactQuad.map((v,i)=>i%2?bounds[1]+v*sy:bounds[0]+v*sx);
      const indices=before.chars.map((c,i)=>overlaps(c.quad,quad)?i:-1).filter(i=>i>=0);
      const selected=indices.map(i=>before.chars[i].c).join('');
      if(!indices.length || norm(selected)!==norm(item.originalText))
        throw new Error('This PDF text cannot be isolated safely. Try selecting a different text item.');
      indices.forEach(i=>removedChars.add(i));
      const a=page.createAnnotation('Redact');
      try {a.setRect(rect(quad));a.setQuadPoints([quad]);a.update();
        a.applyRedaction(false,mupdf.PDFPage.REDACT_IMAGE_NONE,mupdf.PDFPage.REDACT_LINE_ART_NONE,mupdf.PDFPage.REDACT_TEXT_REMOVE);
      } finally {a.destroy();}
    }
    for(const item of job.images||[]) {
      const r=[bounds[0]+item.x*sx,bounds[1]+item.y*sy,bounds[0]+(item.x+item.w)*sx,bounds[1]+(item.y+item.h)*sy];
      const candidates=before.images.map((im,i)=>close(im.bounds,r,1)?i:-1).filter(i=>i>=0);
      if(candidates.length!==1)throw new Error('This PDF image cannot be isolated safely. No content was changed.');
      removedImages.add(candidates[0]);
      // A small region inside the selected image removes that instance. The
      // subsequent check rejects any removal of an overlapping background image.
      const cx=(r[0]+r[2])/2,cy=(r[1]+r[3])/2;
      const a=page.createAnnotation('Redact');
      try {a.setRect([cx-.2,cy-.2,cx+.2,cy+.2]);a.update();
        a.applyRedaction(false,mupdf.PDFPage.REDACT_IMAGE_REMOVE,mupdf.PDFPage.REDACT_LINE_ART_NONE,mupdf.PDFPage.REDACT_TEXT_NONE);
      } finally {a.destroy();}
    }
    assertPreserved(before,pageContent(page),removedChars,removedImages);
  } finally {page.destroy();}
}
function saveBytes(pdf) {
  const b=pdf.saveToBuffer('garbage=4,compress=yes');
  try {return b.asUint8Array().slice().buffer;} finally {b.destroy();}
}
export async function removeContent(input,jobs,onlyPage=null) {
  const imageJobs=jobs.filter(job=>(job.images||[]).length);
  if(imageJobs.length){
    const exact=await tryPreciseImageRemoval(input,imageJobs);
    if(exact){input=exact;jobs=jobs.map(job=>({...job,images:[]}));}
  }
  const precise=await tryPreciseTextRemoval(input,jobs.filter(job=>(job.items||[]).length||(job.images||[]).length),onlyPage);if(precise)return precise;
  await loadMupdf();
  const doc=mupdf.Document.openDocument(input,'application/pdf');
  let single;
  try {
    const pdf=doc.asPDF();jobs.forEach(job=>applyJob(pdf,job));
    if(onlyPage!=null) {single=new mupdf.PDFDocument();single.graftPage(-1,pdf,onlyPage-1);return saveBytes(single);}
    return saveBytes(pdf);
  } finally {single?.destroy();doc.destroy();}
}
if(typeof self!=='undefined')self.onmessage=async({data})=>{
  const {id,type}=data;
  try {
    if(type==='init'){original=data.bytes;self.postMessage({id,ok:true});return;}
    if(type==='clear'){original=null;self.postMessage({id,ok:true});return;}
    if(!original)throw new Error('Open a PDF before editing.');
    const bytes=await removeContent(original,data.jobs,data.onlyPage??null);
    self.postMessage({id,ok:true,bytes},[bytes]);
  } catch(e){self.postMessage({id,ok:false,error:e.message||'PDF content removal failed.'});}
};

if(typeof self!=='undefined')self.postMessage({ready:true});
