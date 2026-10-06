// Remove complete text-show operands without rewriting neighboring operators.
// Keep the original text advance with a numeric TJ operand, so later glyphs stay
// in position. Unsupported encodings, clipping and ambiguous glyph matches use the fallback.
const norm=s=>s.normalize('NFKC').replace(/\s/g,'');
const mul=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
function tokens(source){
 const out=[];let i=0;
 while(i<source.length){const start=i,c=source[i];if(/\s/.test(c)){i++;continue;}if(c==='%'){while(i<source.length&&!/[\r\n]/.test(source[i]))i++;continue;}
  if(c==='('){let depth=1,value='';i++;while(i<source.length&&depth){let c=source[i++];if(c==='\\'){let x=source[i++];if(/[0-7]/.test(x)){let oct=x;for(let k=0;k<2&&/[0-7]/.test(source[i]||'x');k++)oct+=source[i++];value+=String.fromCharCode(parseInt(oct,8)&255);}else if(x==='\r'||x==='\n'){if(x==='\r'&&source[i]==='\n')i++;}else value+=({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f'})[x]??x;}else{if(c==='(')depth++;if(c===')')depth--;if(depth)value+=c;}}
   if(depth)throw new Error('Unterminated PDF string');out.push({type:'string',value,start,end:i});continue;
  }
  if(c==='<'&&source[i+1]!=='<'){i++;let hex='';while(i<source.length&&source[i]!=='>'){if(!/\s/.test(source[i]))hex+=source[i];i++;}if(i>=source.length||!/^[\da-f]*$/i.test(hex))throw new Error('Invalid hex string');i++;if(hex.length%2)hex+='0';out.push({type:'string',value:hex.match(/../g)?.map(x=>String.fromCharCode(parseInt(x,16))).join('')||'',start,end:i});continue;}
  if(c==='['||c===']'){out.push({type:c,value:c,start,end:++i});continue;}
  if(c==='/'){i++;while(i<source.length&&!/[\s()[\]<>/%]/.test(source[i]))i++;out.push({type:'name',value:source.slice(start+1,i).replace(/#([a-f\d]{2})/ig,(_,h)=>String.fromCharCode(parseInt(h,16))),start,end:i});continue;}
  if(/[<>]/.test(c))throw new Error('Unsupported dictionary in page content');
  while(i<source.length&&!/[\s()[\]<>/%]/.test(source[i]))i++;if(i===start)throw new Error('Unsupported content token');
  const word=source.slice(start,i);out.push({type:/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)?'number':'op',value:word,start,end:i});
  if(word==='BI')throw new Error('Inline image requires the other removal engine');
 }
 return out;
}
function unicodeMap(stream,L){
 if(!stream)return null;
 const source=Array.from(L.decodePDFRawStream(stream).decode(),x=>String.fromCharCode(x)).join('').replace(/%[^\r\n]*/g,'');
 if(/\busecmap\b/.test(source))return null;
 const lengths=new Set();for(const block of source.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g))for(const m of block[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>/gi)){if(m[1].length!==m[2].length)return null;lengths.add(m[1].length/2);}
 if(lengths.size!==1||![1,2].includes([...lengths][0]))return null;
 const length=[...lengths][0],map=new Map(),unicode=hex=>{if(hex.length%4)throw new Error('Invalid Unicode map');return (hex.match(/.{4}/g)||[]).map(h=>String.fromCharCode(parseInt(h,16))).join('').replace(/^\uFEFF/,'');};
 const put=(hex,value)=>{if(hex.length!==length*2)throw new Error('Mixed character code lengths');map.set(parseInt(hex,16),unicode(value));};
 for(const block of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))for(const m of block[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>/gi))put(m[1],m[2]);
 for(const block of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))for(const m of block[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>\s*(<([\da-f]+)>|\[([^\]]*)\])/gi)){
  const start=parseInt(m[1],16),end=parseInt(m[2],16);if(end<start||end-start>65535)throw new Error('Invalid Unicode range');
  const values=m[5]?[...m[5].matchAll(/<([\da-f]+)>/gi)].map(x=>x[1]):null;if(values&&values.length!==end-start+1)throw new Error('Incomplete Unicode range');
  for(let code=start;code<=end;code++){const value=values?values[code-start]:(BigInt('0x'+m[4])+BigInt(code-start)).toString(16).padStart(m[4].length,'0');put(code.toString(16).padStart(length*2,'0'),value);}
 }
 return {length,map};
}
function fontDecoder(length,map){return value=>{if(value.length%length)throw new Error('Incomplete character code');const glyphs=[];for(let i=0;i<value.length;i+=length){const bytes=value.slice(i,i+length);let code=0;for(const c of bytes)code=code*256+c.charCodeAt(0);const text=map?map.get(code):(code>=32&&code<127?bytes:null);glyphs.push({c:text??null,bytes,code,wordSpace:length===1&&code===32});}return glyphs;};}
function candidates(source,fontInfo){
 const ts=tokens(source),runs=[];let args=[],ctm=[1,0,0,1,0,0],stack=[];
 let state={font:null,size:0,leading:0,rise:0,mode:0,charSpace:0,wordSpace:0,hScale:1},bt=null;
 const position=(matrix,offset=0)=>{const m=mul(ctm,matrix);return [m[4]+m[0]*offset+m[2]*state.rise,m[5]+m[1]*offset+m[3]*state.rise];};
 const moveLine=(x,y)=>{if(!bt)throw new Error('Text outside BT');bt.line=mul(bt.line,[1,0,0,1,x,y]);bt.text=bt.line.slice();bt.known=true;};
 for(const t of ts){if(t.type!=='op'){args.push(t);continue;}const n=args.filter(x=>x.type==='number').map(x=>+x.value);
  switch(t.value){
   case'q':stack.push({ctm:ctm.slice(),state:{...state}});break;
   case'Q':{const saved=stack.pop();if(!saved)throw new Error('Unbalanced graphics state');ctm=saved.ctm;state=saved.state;break;}
   case'cm':if(n.length!==6)throw new Error('Invalid matrix');ctm=mul(ctm,n);break;
   case'BT':if(bt)throw new Error('Nested text');bt={line:[1,0,0,1,0,0],text:[1,0,0,1,0,0],known:true};break;
   case'ET':if(!bt)throw new Error('Unbalanced text');bt=null;break;
   case'Tf':state.font=args.find(x=>x.type==='name')?.value;state.size=n[0];break;
   case'TL':state.leading=n[0];break;
   case'Ts':state.rise=n[0];break;
   case'Tr':state.mode=n[0];break;
   case'Tc':state.charSpace=n[0];break;
   case'Tw':state.wordSpace=n[0];break;
   case'Tz':state.hScale=n[0]/100;break;
   case'Tm':if(!bt||n.length!==6)throw new Error('Invalid text matrix');bt.line=n.slice();bt.text=n.slice();bt.known=true;break;
   case'TD':state.leading=-n[1]; // fall through
   case'Td':if(n.length!==2)throw new Error('Invalid text position');moveLine(n[0],n[1]);break;
   case'T*':moveLine(0,-state.leading);break;
   case'Tj':case'TJ':case"'":case'"':{
    if(!bt)throw new Error('Text outside BT');
    if(t.value==='"'){state.wordSpace=n[0];state.charSpace=n[1];}
    if(t.value==="'"||t.value==='"')moveLine(0,-state.leading);
    const font=fontInfo(state.font),parts=t.value==='TJ'?args.filter(x=>x.type==='string'||x.type==='number'):args.filter(x=>x.type==='string');
    let advance=0,leading=0,visible=false;const glyphs=[];
    for(const part of parts){
     if(part.type==='number'){advance-=+part.value*state.size/1000;if(!visible)leading=advance;continue;}
     part.glyphs=font?font.decode(part.value):fontDecoder(1,null)(part.value);
     for(const glyph of part.glyphs){const offset=advance,width=font?.width(glyph.code);advance+=(Number.isFinite(width)?width*state.size/1000:NaN)+state.charSpace+(glyph.wordSpace?state.wordSpace:0);glyphs.push({...glyph,point:position(bt.text,offset*state.hScale),advance:advance-offset,index:glyphs.length});if(!visible){if(glyph.c!=null&&/\s/.test(glyph.c))leading=advance;else visible=true;}}
    }
    const first=args[0],safe=bt.known&&!!first&&state.mode>=0&&state.mode<4&&!!font&&state.size>0&&Number.isFinite(advance)&&glyphs.every(g=>g.c!=null);
    const spacer='['+(-advance*1000/state.size).toFixed(8)+'] TJ';
    const replacement=t.value==="'"?'T* '+spacer:t.value==='"'?state.wordSpace+' Tw '+state.charSpace+' Tc T* '+spacer:spacer;
    runs.push({text:glyphs.map(g=>g.c||'').join(''),glyphs,parts,size:state.size,prefix:t.value==="'"?'T* ':t.value==='"'?state.wordSpace+' Tw '+state.charSpace+' Tc T* ':'',points:[position(bt.text),position(bt.text,leading*state.hScale)],start:first?.start,end:t.end,replacement,safe});
    if(Number.isFinite(advance))bt.text=mul(bt.text,[1,0,0,1,advance*state.hScale,0]);else bt.known=false;
    break;
   }
  }
  args=[];
 }
 if(bt||stack.length)throw new Error('Unbalanced content');return runs;
}
export async function tryPreciseTextRemoval(input,jobs,onlyPage=null){
 const L=globalThis.PDFLib;if(!L)return null;
 let pdf;
 try{
  if(jobs.some(j=>(j.images||[]).length))return null;
  pdf=await L.PDFDocument.load(input,{updateMetadata:false});
  for(const job of jobs){
   const page=pdf.getPage(job.pageNumber-1),resources=page.node.Resources(),fonts=resources?.lookup(L.PDFName.of('Font'),L.PDFDict);
   const states=resources?.lookup(L.PDFName.of('ExtGState'));
   if(states instanceof L.PDFDict)for(const [,ref] of states.entries()){const state=pdf.context.lookup(ref);if(state instanceof L.PDFDict&&state.has(L.PDFName.of('Font')))return null;}
   const fontCache=new Map();
   const fontInfo=name=>{if(fontCache.has(name))return fontCache.get(name);let info=null;try{
    const f=fonts?.lookup(L.PDFName.of(name),L.PDFDict),type=f?.lookup(L.PDFName.of('Subtype'))?.toString(),base=f?.lookup(L.PDFName.of('BaseFont'))?.toString()?.slice(1);
    const matrix=f?.lookup(L.PDFName.of('FontMatrix'));
    if(matrix instanceof L.PDFArray&&!matrix.asArray().every((n,i)=>n instanceof L.PDFNumber&&Math.abs(n.asNumber()-[.001,0,0,.001,0,0][i])<1e-9))return null;
    let encoding=f?.lookup(L.PDFName.of('Encoding'));
    let ascii=true;
    if(encoding instanceof L.PDFDict){const differences=encoding.lookup(L.PDFName.of('Differences'));let code=0;if(differences instanceof L.PDFArray)for(const d of differences.asArray()){if(d instanceof L.PDFNumber)code=d.asNumber();else {if(code>=32&&code<127)ascii=false;code++;}}encoding=encoding.lookup(L.PDFName.of('BaseEncoding'));}
    encoding=encoding?.toString();const standard=Object.values(L.StandardFonts).includes(base);
    const toUnicode=f.lookup(L.PDFName.of('ToUnicode')),unicode=unicodeMap(toUnicode,L);
    if(toUnicode&&!unicode)throw new Error('Unsupported Unicode map');
    if(type==='/Type0'&&encoding==='/Identity-H'&&unicode?.length===2){
     const descendant=f.lookup(L.PDFName.of('DescendantFonts'),L.PDFArray)?.lookup(0,L.PDFDict),subtype=descendant?.lookup(L.PDFName.of('Subtype'))?.toString();
     if(!['/CIDFontType0','/CIDFontType2'].includes(subtype))throw new Error('Unsupported composite font');
     const m=descendant.lookup(L.PDFName.of('FontMatrix'));if(m instanceof L.PDFArray&&!m.asArray().every((n,i)=>n instanceof L.PDFNumber&&Math.abs(n.asNumber()-[.001,0,0,.001,0,0][i])<1e-9))throw new Error('Unsupported font matrix');
     const widths=descendant.lookup(L.PDFName.of('W')),values=new Map(),defaultWidth=descendant.lookup(L.PDFName.of('DW'))?.asNumber?.()??1000;
     if(widths instanceof L.PDFArray)for(let i=0;i<widths.size();){const first=widths.lookup(i++,L.PDFNumber).asNumber(),next=widths.lookup(i++);if(next instanceof L.PDFArray){for(let j=0;j<next.size();j++)values.set(first+j,next.lookup(j,L.PDFNumber).asNumber());}else {const last=next.asNumber(),width=widths.lookup(i++,L.PDFNumber).asNumber();if(last<first||last-first>65535)throw new Error('Invalid font widths');for(let code=first;code<=last;code++)values.set(code,width);}}
     info={decode:fontDecoder(2,unicode.map),width:code=>values.get(code)??defaultWidth};
    }else if(['/Type1','/TrueType'].includes(type)&&(unicode?unicode.length===1:(ascii&&(encoding==='/WinAnsiEncoding'||encoding==='/StandardEncoding'||(!encoding&&standard))))){
     const widths=f.lookup(L.PDFName.of('Widths')),first=f.lookup(L.PDFName.of('FirstChar'))?.asNumber?.()||0;
     const metric=standard&&ascii?pdf.embedStandardFont(base):null;
     if(widths instanceof L.PDFArray||metric)info={decode:fontDecoder(1,unicode?.map),width:code=>{if(widths instanceof L.PDFArray){const w=widths.lookup(code-first);return w instanceof L.PDFNumber?w.asNumber():NaN;}try{return metric.widthOfTextAtSize(String.fromCharCode(code),1000);}catch{return NaN;}}};
    }
   }catch{}fontCache.set(name,info);return info;};
   const contents=page.node.Contents(),streams=contents instanceof L.PDFArray?contents.asArray().map(ref=>pdf.context.lookup(ref)):contents?[contents]:[];
   // Latin-1 TextDecoder maps 0x80–0x9f through Windows-1252. Preserve raw bytes explicitly.
   const raw=streams.map(stream=>Array.from(L.decodePDFRawStream(stream).decode(),x=>String.fromCharCode(x)).join('')).join('\n');
   const runs=candidates(raw,fontInfo),flat=[];
   for(const run of runs)if(run.safe)for(const glyph of run.glyphs)if(norm(glyph.c))flat.push({run,glyph});
   const selected=new Map();
   for(const item of job.items){
    if(!item.sourcePdfPoint)return null;
    const target=norm(item.originalText),matches=[];
    for(let start=0;start<flat.length;start++){
     const first=flat[start];if(!target.startsWith(norm(first.glyph.c))||Math.hypot(first.glyph.point[0]-item.sourcePdfPoint[0],first.glyph.point[1]-item.sourcePdfPoint[1])>=.2)continue;
     const slice=[];let text='';for(let i=start;i<flat.length&&text.length<target.length;i++){slice.push(flat[i]);text+=norm(flat[i].glyph.c);if(!target.startsWith(text))break;}if(text!==target)continue;
     // A PDF.js text item stays on one baseline; do not match unrelated rows.
     let dx=0,dy=0;if(slice.length>1){dx=slice.at(-1).glyph.point[0]-first.glyph.point[0];dy=slice.at(-1).glyph.point[1]-first.glyph.point[1];}
     const length=Math.hypot(dx,dy);if(length){dx/=length;dy/=length;}
     let valid=true;
     for(let i=1;i<slice.length;i++){
      const a=slice[i-1],b=slice[i],x=b.glyph.point[0]-first.glyph.point[0],y=b.glyph.point[1]-first.glyph.point[1];
      if(Math.abs(x*dy-y*dx)>.2||Math.hypot(b.glyph.point[0]-a.glyph.point[0],b.glyph.point[1]-a.glyph.point[1])>Math.max(a.run.size,b.run.size)*4){valid=false;break;}
     }
     if(valid)matches.push(slice);
    }
    if(matches.length!==1)return null;
    for(const {run,glyph} of matches[0]){if(!selected.has(run))selected.set(run,new Set());selected.get(run).add(glyph.index);}
   }
   const literal=value=>'('+[...value].map(c=>/[()\\]/.test(c)?'\\'+c:c.charCodeAt(0)<32||c.charCodeAt(0)>126?'\\'+c.charCodeAt(0).toString(8).padStart(3,'0'):c).join('')+')';
   const changes=[];
   for(const [run,indices] of selected){
    const letters=run.glyphs.filter(g=>norm(g.c));
    if(letters.every(g=>indices.has(g.index)))run.glyphs.forEach(g=>indices.add(g.index));
    else for(let i=1;i<letters.length;i++)if(indices.has(letters[i-1].index)&&indices.has(letters[i].index))for(let j=letters[i-1].index+1;j<letters[i].index;j++)indices.add(j);
    const output=[];let index=0,string='',removed=0;
    const flushString=()=>{if(string){output.push(literal(string));string='';}};
    const flushRemoved=()=>{if(removed){output.push((-removed*1000/run.size).toFixed(8));removed=0;}};
    for(const part of run.parts){
     if(part.type==='number'){flushString();flushRemoved();output.push(part.value);continue;}
     for(const glyph of part.glyphs){if(indices.has(index)){flushString();removed+=run.glyphs[index].advance;}else {flushRemoved();string+=glyph.bytes;}index++;}
    }
    flushString();flushRemoved();changes.push({...run,replacement:run.prefix+'['+output.join(' ')+'] TJ'});
   }
   let edited=raw;for(const r of changes.sort((a,b)=>b.start-a.start))edited=edited.slice(0,r.start)+r.replacement+edited.slice(r.end);
   page.node.set(L.PDFName.of('Contents'),pdf.context.register(pdf.context.flateStream(Uint8Array.from(edited,c=>c.charCodeAt(0)))));
  }
  if(onlyPage!=null){const single=await L.PDFDocument.create();const [page]=await single.copyPages(pdf,[onlyPage-1]);single.addPage(page);return (await single.save({updateFieldAppearances:false})).buffer;}
  return (await pdf.save({updateFieldAppearances:false})).buffer;
 }catch{return null;}
}

// Remove individual image draw operands, preserving overlapping graphics.
// Shared Form XObjects are copied only along the selected invocation path.
export async function tryPreciseImageRemoval(input,jobs){
 const L=globalThis.PDFLib;if(!L)return null;
 try{
  const pdf=await L.PDFDocument.load(input,{updateMetadata:false});
  const N=L.PDFName.of,identity=[1,0,0,1,0,0];let serial=0;
  const multiply=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
  const transform=(m,x,y)=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];
  const decode=stream=>Array.from(L.decodePDFRawStream(stream).decode(),c=>String.fromCharCode(c)).join('');
  const encode=raw=>Uint8Array.from(raw,c=>c.charCodeAt(0));
  const dictRecord=dict=>Object.fromEntries(dict.entries().filter(([key])=>!['Length','Filter','DecodeParms'].includes(key.decodeText())).map(([key,value])=>[key.decodeText(),value]));
  function operations(raw){
   let pos=0,args=[],result=[];
   const space=()=>{while(pos<raw.length){if(/[\s\0]/.test(raw[pos])){pos++;continue;}if(raw[pos]==='%'){while(pos<raw.length&&!/[\r\n]/.test(raw[pos]))pos++;continue;}break;}};
   const delimiter=c=>c==null||/[\s\0()[\]<>/%]/.test(c);
   function token(){
    space();const start=pos,c=raw[pos];if(c==null)throw Error('Unexpected end of content');
    if(c==='('){let depth=1;pos++;while(pos<raw.length&&depth){const ch=raw[pos++];if(ch==='\\'){if(raw[pos]==='\r'&&raw[pos+1]==='\n')pos++;pos++;}else if(ch==='(')depth++;else if(ch===')')depth--;}if(depth)throw Error('Invalid PDF string');return {start,end:pos,type:'value'};}
    if(c==='['||(c==='<'&&raw[pos+1]==='<')){const close=c==='['?']':'>>';pos+=c==='['?1:2;while(true){space();if(raw.slice(pos,pos+close.length)===close){pos+=close.length;break;}token();}return {start,end:pos,type:'value'};}
    if(c==='<'){pos++;while(pos<raw.length&&raw[pos]!=='>')pos++;if(pos>=raw.length)throw Error('Invalid hex string');pos++;return {start,end:pos,type:'value'};}
    if(c==='/'){pos++;const begin=pos;while(pos<raw.length&&!delimiter(raw[pos]))pos++;return {start,end:pos,type:'name',value:raw.slice(begin,pos).replace(/#([\da-f]{2})/gi,(_,h)=>String.fromCharCode(parseInt(h,16)))};}
    while(pos<raw.length&&!delimiter(raw[pos]))pos++;if(pos===start)throw Error('Invalid token');
    const value=raw.slice(start,pos);return {start,end:pos,type:/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)?'number':/^(true|false|null)$/.test(value)?'value':'op',value};
   }
   while(true){space();if(pos>=raw.length)break;const t=token();if(t.type!=='op'){args.push(t);continue;}
    // Binary inline images require the other removal engine; don't guess EI.
    if(t.value==='BI')throw Error('Inline image stream');
    result.push({op:t.value,args,start:args[0]?.start??t.start,end:t.end});args=[];
   }
   return result;
  }
  for(const job of jobs){
   if(!(job.images||[]).length)continue;
   const page=pdf.getPage(job.pageNumber-1),records=[];
   const original=page.node.Contents(),streams=original instanceof L.PDFArray?original.asArray().map(ref=>pdf.context.lookup(ref)):original?[original]:[];
   const resources=page.node.Resources()||L.PDFDict.withContext(pdf.context);
   function walk(raw,res,matrix,ancestors=new Set()){
    const tree={raw,res,children:[],changed:false};let ctm=matrix.slice(),stack=[];
    const xobjects=res.lookupMaybe(N('XObject'),L.PDFDict);
    for(const op of operations(raw)){
     if(op.op==='q'){stack.push(ctm.slice());continue;}
     if(op.op==='Q'){if(!stack.length)throw Error('Invalid graphics state');ctm=stack.pop();continue;}
     if(op.op==='cm'){if(op.args.length!==6||op.args.some(a=>a.type!=='number'))throw Error('Invalid matrix');ctm=multiply(ctm,op.args.map(a=>+a.value));continue;}
     if(op.op!=='Do')continue;
     if(op.args.length!==1||op.args[0].type!=='name')throw Error('Invalid XObject invocation');
     const name=op.args[0].value,stream=xobjects?.lookup(N(name));if(!(stream instanceof L.PDFRawStream))throw Error('Unsupported XObject');
     const kind=stream.dict.lookup(N('Subtype'))?.toString(),child={...op,name,stream,kind,selected:false};tree.children.push(child);
     if(kind==='/Image'){
      child.quad=[...transform(ctm,0,0),...transform(ctm,1,0),...transform(ctm,0,1),...transform(ctm,1,1)];
      if(stream.dict.lookup(N('ImageMask'))?.toString()!=='true')records.push(child);
     }else if(kind==='/Form'){
      if(ancestors.has(stream)||ancestors.size>24)throw Error('Recursive form');
      const formMatrix=stream.dict.lookupMaybe(N('Matrix'),L.PDFArray);
      const m=formMatrix?formMatrix.asArray().map(n=>n.asNumber()):identity;
      if(m.length!==6||m.some(n=>!Number.isFinite(n)))throw Error('Invalid form matrix');
      const ownResources=stream.dict.lookupMaybe(N('Resources'),L.PDFDict)||res;
      child.tree=walk(decode(stream),ownResources,multiply(ctm,m),new Set([...ancestors,stream]));
     }
    }
    if(stack.length)throw Error('Unbalanced graphics state');return tree;
   }
   const tree=walk(streams.map(decode).join('\n'),resources,identity);
   for(const selected of job.images){
    let matches;
    if(Array.isArray(selected.sourcePdfQuad)&&selected.sourcePdfQuad.length===8){
     matches=records.filter(r=>r.quad.every((n,i)=>Math.abs(n-selected.sourcePdfQuad[i])<.25));
    }else{
     // Backward compatibility for unrotated documents from older sessions.
     if(page.getRotation().angle%360)return null;
     const crop=page.getCropBox(),sx=crop.width/job.width,sy=crop.height/job.height;
     const target=[crop.x+selected.x*sx,crop.y+crop.height-(selected.y+selected.h)*sy,crop.x+(selected.x+selected.w)*sx,crop.y+crop.height-selected.y*sy];
     matches=records.filter(r=>{const xs=[r.quad[0],r.quad[2],r.quad[4],r.quad[6]],ys=[r.quad[1],r.quad[3],r.quad[5],r.quad[7]];return [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)].every((n,i)=>Math.abs(n-target[i])<.7);});
    }
    const occurrence=selected.sourceImageOccurrence;
    const candidate=matches.length===1?matches[0]:Number.isInteger(occurrence)&&occurrence>=0?matches[occurrence]:null;
    if(!candidate||candidate.selected)return null;candidate.selected=true;
   }
   function rewrite(tree){
    const res=tree.res.clone(pdf.context),oldX=res.lookupMaybe(N('XObject'),L.PDFDict),xobjects=oldX?oldX.clone(pdf.context):L.PDFDict.withContext(pdf.context),changes=[],changedNames=new Set();
    for(const child of tree.children){
     if(child.selected){changes.push({start:child.start,end:child.end,text:''});changedNames.add(child.name);continue;}
     if(!child.tree)continue;
     const edited=rewrite(child.tree);if(!edited)continue;
     const dict=dictRecord(child.stream.dict);dict.Resources=edited.res;
     const ref=pdf.context.register(pdf.context.flateStream(encode(edited.raw),dict));
     let name;do{name='RiloImageEdit'+(++serial);}while(xobjects.has(N(name)));
     xobjects.set(N(name),ref);changes.push({start:child.start,end:child.end,text:'/'+name+' Do'});changedNames.add(child.name);
    }
    if(!changes.length)return null;
    let raw=tree.raw;for(const c of changes.sort((a,b)=>b.start-a.start))raw=raw.slice(0,c.start)+c.text+raw.slice(c.end);
    const used=new Set(operations(raw).filter(op=>op.op==='Do').map(op=>op.args[0].value));
    for(const name of changedNames)if(!used.has(name))xobjects.delete(N(name));
    res.set(N('XObject'),xobjects);return {raw,res};
   }
   const edited=rewrite(tree);if(!edited)return null;
   page.node.set(N('Resources'),edited.res);
   page.node.set(N('Contents'),pdf.context.register(pdf.context.flateStream(encode(edited.raw))));
  }
  // Copy only reachable objects, so an unused removed image is not carried over.
  const cleaned=await L.PDFDocument.create(),copies=await cleaned.copyPages(pdf,pdf.getPageIndices());copies.forEach(page=>cleaned.addPage(page));
  return (await cleaned.save({updateFieldAppearances:false})).buffer;
 }catch{return null;}
}
