// PDF content removal runs off the UI thread. The original bytes stay in memory.
let mupdf=null;
async function loadMupdf(){if(!mupdf)mupdf=await import('./vendor/mupdf/mupdf.js');return mupdf;}
import './vendor/pdf-lib.min.js';
import {tryPreciseTextRemoval,tryPreciseImageRemoval} from './precise-text-removal.js';
let original = null;
const rasterImages=new Map();
const rasterKey=(page,quad,occurrence)=>page+'|'+quad.map(v=>v.toFixed(2)).join('|')+'|'+occurrence;
const norm = s => s.normalize('NFKD').replace(/\s/g, '');
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
      const target=norm(item.originalText),actual=norm(selected),copies=target?actual.length/target.length:0;
      if(!indices.length || !Number.isInteger(copies)||copies<1||actual!==target.repeat(copies))
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
  let rasterDocument=null;
  const imageJobs=jobs.filter(job=>(job.images||[]).length||job.items?.some(item=>item.pixelErase));
  if(imageJobs.length){
    let editor=null;
    if(imageJobs.some(job=>job.items?.some(item=>item.pixelErase))){await loadMupdf();rasterDocument=mupdf.Document.openDocument(input,'application/pdf');editor=(record,erasures)=>eraseRasterText(rasterDocument.asPDF(),record,erasures);}
    let exact;try{exact=await tryPreciseImageRemoval(input,imageJobs,editor);}finally{rasterDocument?.destroy();}
    if(editor&&!exact)throw new Error('The image copy of this text could not be removed safely. No changes were saved.');
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
function eraseRasterText(pdf,record,erasures){
  const q=record.quad,a=q[2]-q[0],b=q[3]-q[1],c=q[4]-q[0],d=q[5]-q[1],det=a*d-b*c;
  if(Math.abs(det)<1e-8||!record.ref?.objectNumber)return null;
  const unit=(x,y)=>[(d*(x-q[0])-c*(y-q[1]))/det,(-b*(x-q[0])+a*(y-q[1]))/det];
  const regions=erasures.map(e=>({...e,uv:e.quad.reduce((all,_,i)=>i%2?all:[...all,unit(e.quad[i],e.quad[i+1])],[])})).filter(e=>Math.max(...e.uv.map(p=>p[0]))>0&&Math.min(...e.uv.map(p=>p[0]))<1&&Math.max(...e.uv.map(p=>p[1]))>0&&Math.min(...e.uv.map(p=>p[1]))<1);
  if(!regions.length)return null;
  let ref,image,pix,rgb;
  try{
    const cached=rasterImages.get(rasterKey(record.pageNumber,record.quad,record.occurrence));
    if(cached){rgb=new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB,[0,0,cached.width,cached.height],true);rgb.getPixels().set(cached.pixels);}
    else {ref=pdf.newIndirect(record.ref.objectNumber);image=pdf.loadImage(ref);pix=image.toPixmap();rgb=pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB,true);}
    const W=rgb.getWidth(),H=rgb.getHeight(),stride=rgb.getStride(),n=rgb.getNumberOfComponents(),pixels=rgb.getPixels(),original=pixels.slice();let changed=0;
    for(const region of regions){
      const x0=Math.max(0,Math.floor(Math.min(...region.uv.map(p=>p[0]))*W)),x1=Math.min(W,Math.ceil(Math.max(...region.uv.map(p=>p[0]))*W));
      const y0=Math.max(0,Math.floor((1-Math.max(...region.uv.map(p=>p[1])))*H)),y1=Math.min(H,Math.ceil((1-Math.min(...region.uv.map(p=>p[1])))*H));
      if(x1<=x0||y1<=y0)continue;
      const bg=region.background.match(/[a-f\d]{2}/gi).map(h=>parseInt(h,16));
      const contrast=(x,y)=>{if(x<0||y<0||x>=W||y>=H)return 0;const i=y*stride+x*n;return Math.max(...bg.map((v,k)=>Math.abs(v-original[i+k])));};
      const line=new Set(),rw=x1-x0,rh=y1-y0;
      // Keep rules that extend beyond the selected word, including cell borders.
      for(let y=y0;y<y1;y++){let start=x0;while(start<x1){if(contrast(start,y)<35){start++;continue;}let left=start,right=start;while(left>0&&contrast(left-1,y)>=35)left--;while(right+1<W&&contrast(right+1,y)>=35)right++;if(right-left+1>rw+8)for(let x=start;x<Math.min(x1,right+1);x++)line.add(y*W+x);start=right+1;}}
      for(let x=x0;x<x1;x++){let start=y0;while(start<y1){if(contrast(x,start)<35){start++;continue;}let top=start,bottom=start;while(top>0&&contrast(x,top-1)>=35)top--;while(bottom+1<H&&contrast(x,bottom+1)>=35)bottom++;if(bottom-top+1>rh+8)for(let y=start;y<Math.min(y1,bottom+1);y++)line.add(y*W+x);start=bottom+1;}}
      for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
        if(line.has(y*W+x)||contrast(x,y)<3)continue;
        let ink=contrast(x,y)>30;
        if(!ink)for(let dy=-2;dy<=2&&!ink;dy++)for(let dx=-2;dx<=2&&!ink;dx++)if(!line.has((y+dy)*W+x+dx)&&contrast(x+dx,y+dy)>30)ink=true;
        if(!ink)continue;const i=y*stride+x*n;for(let k=0;k<3;k++)pixels[i+k]=bg[k];changed++;
      }
    }
    return changed?rgb.asPNG():null;
  }finally{rgb?.destroy();pix?.destroy();image?.destroy();ref?.destroy();}
}
if(typeof self!=='undefined')self.onmessage=async({data})=>{
  const {id,type}=data;
  try {
    if(type==='init'){original=data.bytes;rasterImages.clear();self.postMessage({id,ok:true});return;}
    if(type==='raster'){for(const image of data.images)rasterImages.set(rasterKey(data.pageNumber,image.quad,image.occurrence),image);self.postMessage({id,ok:true});return;}
    if(type==='clear'){original=null;rasterImages.clear();self.postMessage({id,ok:true});return;}
    if(!original)throw new Error('Open a PDF before editing.');
    const bytes=await removeContent(original,data.jobs,data.onlyPage??null);
    self.postMessage({id,ok:true,bytes},[bytes]);
  } catch(e){self.postMessage({id,ok:false,error:e.message||'PDF content removal failed.'});}
};

if(typeof self!=='undefined')self.postMessage({ready:true});
