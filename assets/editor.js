
  (() => {
    'use strict';

    const $ = (s, r=document) => r.querySelector(s);
    const $$ = (s, r=document) => [...r.querySelectorAll(s)];
    const clamp = (n,min,max) => Math.min(max,Math.max(min,n));
    const deep = o => Object.fromEntries(Object.entries(o).map(([k,v])=>[k,Array.isArray(v)?v.slice():v]));
    const escapeHtml = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const uid = () => 'o_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-5);

    const startView = $('#startView');
    const editorView = $('#editorView');
    const fileInput = $('#fileInput');
    const imageInput = $('#imageInput');
    const uploadBtn = $('#uploadBtn');
    const dropZone = $('#dropZone');
    const workspace = $('#workspace');
    const propertybar = $('#propertybar');
    const textProps = $('#textProps');
    const imageProps = $('#imageProps');
    const shapeProps = $('#shapeProps');
    const toast = $('#toast');
    const busy = $('#busy');
    const busyText = $('#busyText');
    const busyProgress = $('#busyProgress');
    const busyProgressFill = $('#busyProgressFill');
    const busyPercent = $('#busyPercent');
    const undoBtn = $('#undoBtn');
    const palette = $('#palette');
    const shapeMenu = $('#shapeMenu');
    const savedImagesBox = $('#savedImages');
    const layersPanel = $('#layersPanel');
    const layersList = $('#layersList');
    const layersEmpty = $('#layersEmpty');
    const layersSub = $('#layersSub');
    const toggleLayersBtn = $('#toggleLayersBtn');
    const closeLayersBtn = $('#closeLayersBtn');
    const startBlankBtn = $('#startBlankBtn');
    const blankPdfBtnTop = $('#blankPdfBtnTop');
    const afterDownload = $('#afterDownload');
    const continueEditingBtn = $('#continueEditingBtn');
    const afterOpenPdfBtn = $('#afterOpenPdfBtn');
    const afterBlankBtn = $('#afterBlankBtn');

    let pdfDoc = null;
    let originalBytes = null;
    let originalFileName = 'edited.pdf';
    let pageRecords = new Map();
    let pageOrder = [];
    let history = [], redoHistory = [], committedState=null, savedSignature='', applyingHistory=false;
    const pageBank=new Map();
    const MAX_BYTES=50*1024*1024, MAX_PAGES=200;
    let documentGeneration=0, loadingDocument=false;
    let renderQueue=Promise.resolve();
    let pageObserver=null;
    let activeTool = 'text';
    let shapeDrawArmed = false;
    let defaultShapeKind = 'rectangle';
    let currentPage = null;
    let selected = null; // { pageNum, id }
    let zoom = 1;
    let defaultShapeFill = '#ffffff';
    let defaultShapeBorder = '#0b75f6';
    let lastShapeFillColor = '#ffffff';
    let lastShapeBorderColor = '#0b75f6';
    let defaultShapeBorderWidth = 2;
    let textDefaults = { fontSize:20, color:'#000000', bold:false, underline:false, fontFamily:'Arial, sans-serif' };
    let exportInProgress = false;
    let imageLibrary = [];
    let layersOpen = false;

    const PDFJS_URL='assets/vendor/pdfjs/pdf.mjs';
    const PDFJS_WORKER_URL='assets/vendor/pdfjs/pdf.worker.mjs';
    const PDFLIB_URL='assets/vendor/pdf-lib.min.js';
    let pdfLibrariesPromise=null,pdfRenderWorker=null,pdfRenderPort=null;
    const hostedAssets=window.PDFRiloHostedAssets;
    const assetUrl=path=>hostedAssets.url(path);
    function withTimeout(promise,ms=45000,message='This operation took too long. Please try again.'){
      let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms)})]).finally(()=>clearTimeout(timer));
    }
    function loadExternalScript(src,readyCheck){
      if(readyCheck())return Promise.resolve();
      return withTimeout(new Promise((resolve,reject)=>{
        const script=document.createElement('script');script.src=src;script.async=true;
        script.onload=()=>resolve();script.onerror=()=>{script.remove();reject(new Error('PDF tools could not load. Please reload the page and try again.'));};
        document.head.appendChild(script);
      }),30000,'PDF tools could not load. Please reload the page and try again.');
    }
    async function ensurePdfLibraries(){
      if(!pdfLibrariesPromise)pdfLibrariesPromise=(async()=>{
        await hostedAssets.ready();
        const js=await import(assetUrl(PDFJS_URL));
        window.pdfjsLib=js;js.GlobalWorkerOptions.workerSrc=assetUrl(PDFJS_WORKER_URL);
        // Explicit ownership: destroying a preview document must not destroy the
        // renderer shared with the main document and subsequent previews.
        
        pdfRenderWorker=new js.PDFWorker(pdfRenderPort?{port:pdfRenderPort}:{});
        await pdfRenderWorker.promise;
        await ensureEditorFont('RiloSans');
      })().catch(e=>{pdfRenderWorker?.destroy();pdfRenderPort?.terminate();pdfRenderWorker=null;pdfRenderPort=null;pdfLibrariesPromise=null;throw e;});
      return withTimeout(pdfLibrariesPromise);
    }
    const editorFontLoads=new Map();
    let sourceFontDocument=null,sourceFontSerial=0;
    const sourcePdfFonts=new Map(),sourceFontLoads=new Map();
    async function loadSourcePdfFont(name){
      if(!name||typeof FontFace==='undefined')return null;
      if(sourceFontLoads.has(name))return sourceFontLoads.get(name);
      const generation=documentGeneration;
      const promise=(async()=>{
        await ensureWritingTools();
        if(!sourceFontDocument)sourceFontDocument=PDFLib.PDFDocument.load(originalBytes,{updateMetadata:false});
        const doc=await sourceFontDocument,N=PDFLib.PDFName.of;
        for(const [,value] of doc.context.enumerateIndirectObjects()){
          if(!(value instanceof PDFLib.PDFDict)||value.lookup(N('Type'))?.toString()!=='/Font')continue;
          const base=value.lookup(N('BaseFont'))?.decodeText?.();if(base!==name)continue;
          const descendants=value.lookupMaybe(N('DescendantFonts'),PDFLib.PDFArray),font=descendants?descendants.lookup(0,PDFLib.PDFDict):value,descriptor=font.lookupMaybe(N('FontDescriptor'),PDFLib.PDFDict),stream=descriptor?.lookup(N('FontFile2'));
          if(!(stream instanceof PDFLib.PDFRawStream))continue;
          const bytes=PDFLib.decodePDFRawStream(stream).decode().slice(),parsed=window.fontkit.create(bytes),family='RiloPdf'+generation+'_'+sourceFontSerial++;
          const style=/italic|oblique/i.test(parsed.subfamilyName||parsed.postscriptName)?'italic':'normal',weight=/bold|black|heavy/i.test(parsed.subfamilyName||parsed.postscriptName)?'700':'400';
          const face=new FontFace(family,bytes,{weight,style});await face.load();if(generation!==documentGeneration)return null;
          document.fonts.add(face);const entry={family,bytes,face,weight,style,supported:new Set(parsed.characterSet),fallback:compatibleFont(parsed.familyName)};sourcePdfFonts.set(family,entry);return entry;
        }
        return null;
      })().catch(()=>null);sourceFontLoads.set(name,promise);return promise;
    }
    function ensureEditorFont(family){
      const f=compatibleFont(family);if(!editorFontLoads.has(f))editorFontLoads.set(f,Promise.all(['normal 400','normal 700','italic 400','italic 700'].map(v=>document.fonts.load(v+' 16px '+f))));return editorFontLoads.get(f);
    }
    async function ensureWritingTools(fonts=true){
      await loadExternalScript(assetUrl(PDFLIB_URL),()=>!!window.PDFLib);
      if(fonts)await loadExternalScript(assetUrl('assets/vendor/fontkit.min.js'),()=>!!window.fontkit);
    }
    function pdfOptions(bytes){return {data:bytes,worker:pdfRenderWorker,isEvalSupported:false,enableScripting:false,cMapUrl:'assets/vendor/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'assets/vendor/pdfjs/standard_fonts/',maxImageSize:16777216,useSystemFonts:false,...hostedAssets.pdfOptions()};}
    function showError(error,title='Unable to complete the operation'){
      const message=String(error?.message||error||'Something went wrong. Please try again.');
      let human=message;
      if(/dynamically imported module|Failed to fetch|PDF tools could not load/i.test(message))human='The PDF tools could not load. Publish the complete website folder including assets, then reload.';
      else if(/Password|password|encrypt/i.test(message))human='This PDF is password protected and cannot currently be opened by PDFRilo.';
      else if(/InvalidPDF|Invalid PDF|corrupt|damaged|format/i.test(message))human='This PDF appears to be damaged or unsupported. Try opening a different copy.';
      else if(/is not a function|Cannot read|undefined|WebAssembly|wasm|WinAnsi|Invalid font/i.test(message))human='This PDF contains content or fonts that this browser cannot safely process. Try a different PDF or update your browser.';
      else if(/memory|allocation|Array buffer|canvas.*size/i.test(message))human='Your browser ran out of memory. Try a smaller PDF or close other browser tabs.';
      $('#errorTitle').textContent=title;$('#errorMessage').textContent=human;
      if(!$('#errorDialog').open)$('#errorDialog').showModal();
    }
    $('#closeError').addEventListener('click',()=>$('#errorDialog').close());

    function showToast(message, ms=1800){
      toast.textContent = message;
      toast.classList.add('show');
      clearTimeout(showToast.t);
      showToast.t = setTimeout(()=>toast.classList.remove('show'), ms);
    }
    function setBusy(on, text='Working…', progress=null){
      busyText.textContent = text;
      busy.classList.toggle('hidden', !on);
      const hasProgress=on && Number.isFinite(progress);
      busyProgress.classList.toggle('hidden',!hasProgress);
      busyPercent.classList.toggle('hidden',!hasProgress);
      if(hasProgress){
        const pct=clamp(Math.round(progress),0,100);
        busyProgressFill.style.width=pct+'%';
        busyPercent.textContent=pct+'%';
      }else if(!on){
        busyProgressFill.style.width='0%';
        busyPercent.textContent='0%';
      }
    }

    function readPdfFileWithProgress(file,onProgress){
      return new Promise((resolve,reject)=>{
        const reader=new FileReader();
        reader.onerror=()=>reject(reader.error||new Error('Could not read PDF file'));
        reader.onabort=()=>reject(new Error('PDF file reading was cancelled'));
        reader.onprogress=e=>{
          if(e.lengthComputable && e.total>0){
            const filePct=e.loaded/e.total;
            // Reserve the last 35% for parsing and page rendering.
            onProgress(5+filePct*60);
          }
        };
        reader.onload=()=>{onProgress(65);resolve(reader.result)};
        reader.readAsArrayBuffer(file);
      });
    }

    $$('.year').forEach(el=>el.textContent=new Date().getFullYear());
    renderImageLibrary();
    layersPanel.classList.toggle('hidden', !layersOpen);
    toggleLayersBtn.classList.toggle('active', layersOpen);
    refreshLayers();

    
    $('#newPdfBtn').addEventListener('click', () => fileInput.click());
    
    blankPdfBtnTop.addEventListener('click', startBlankDocument);
    afterOpenPdfBtn.addEventListener('click',()=>{afterDownload.classList.add('hidden');fileInput.click();});
    afterBlankBtn.addEventListener('click',()=>{afterDownload.classList.add('hidden');startBlankDocument();});
    continueEditingBtn.addEventListener('click',()=>afterDownload.classList.add('hidden'));
    function positionLayersPanel(){
      if(!layersPanel || !toggleLayersBtn || !layersOpen) return;
      const r=toggleLayersBtn.getBoundingClientRect();
      const gap=8;
      const panelW=Math.min(310,Math.max(270,window.innerWidth-20));
      layersPanel.style.width=panelW+'px';
      const left=clamp(r.right-panelW,10,Math.max(10,window.innerWidth-panelW-10));
      const top=Math.min(window.innerHeight-120,r.bottom+gap);
      layersPanel.style.left=left+'px';
      layersPanel.style.right='auto';
      layersPanel.style.top=top+'px';
      layersPanel.style.maxHeight=Math.max(180,window.innerHeight-top-12)+'px';
    }

    async function startBlankDocument(){
      if(loadingDocument||exportInProgress||!confirmDiscard())return;
      loadingDocument=true;
      try{
        setBusy(true,'Loading PDF tools…');await ensurePdfLibraries();
        await ensureWritingTools(false);const out=await PDFLib.PDFDocument.create();out.addPage([595.28,841.89]);
        const bytes=await out.save();await openDocument(bytes.buffer,'blank.pdf','addtext');
        showToast('Blank PDF ready. Add text, images or shapes.');
      }catch(e){showError(e,'Unable to create a blank PDF');}
      finally{loadingDocument=false;setBusy(false);}
    }


    async function loadPdfFile(file){
      if(loadingDocument||exportInProgress)return;
      if(file.size>MAX_BYTES){showError('File too large. Maximum supported PDF size is 50 MB.','File too large');return;}
      if(!/\.pdf$/i.test(file.name)&&file.type!=='application/pdf'){showError('Please choose a PDF file.');return;}
      if(!confirmDiscard())return;
      loadingDocument=true;
      try{
        setBusy(true,'Loading PDF tools…',2);await ensurePdfLibraries();
        const bytes=await readPdfFileWithProgress(file,p=>setBusy(true,'Reading PDF file…',p));
        await openDocument(bytes,file.name,'text');showToast('PDF ready. Click text to edit it.');
      }catch(e){showError(e,'Unable to open PDF');}
      finally{loadingDocument=false;setBusy(false);}
    }
    async function openDocument(bytes,name,tool){
      const task=pdfjsLib.getDocument(pdfOptions(bytes.slice(0)));
      let next;
      try{
        next=await withTimeout(task.promise,45000,'Opening this PDF took too long. Try a smaller PDF.');
        if(next.numPages>MAX_PAGES)throw new Error('This PDF contains too many pages. Maximum supported length is 200 pages.');
        if(next.numPages<1)throw new Error('This PDF has no pages.');
        // Validate page dimensions before replacing the current document.
        for(let i=1;i<=next.numPages;i++){
          const p=await next.getPage(i),v=p.getViewport({scale:1});
          if(v.width>14400||v.height>14400)throw new Error('This PDF contains an unsupported page size.');
        }
      }catch(e){await task.destroy();throw e;}
      await releaseDocument();
      pdfDoc=next;originalBytes=bytes;originalFileName=name.replace(/\.pdf$/i,'')+'-edited.pdf';
      $('#fileName').textContent=name;imageLibrary=[];renderImageLibrary();
      startView.classList.add('hidden');editorView.classList.remove('hidden');
      document.body.classList.add('editing');
      window.scrollTo(0,0);setActiveTool(tool);pageObserver=new IntersectionObserver(entries=>{
        for(const e of entries){const rec=pageRecords.get(e.target.dataset.page);if(!rec)continue;
          if(e.isIntersecting){hydratePage(rec);}
          else if(rec.hydrated && !rec.hydrating && !rec.previewRunning && pageOrder.length>8){
            rec.canvas.width=rec.canvas.height=1;rec.hydrated=false;rec.textLayer.innerHTML='';rec.imageHitLayer.innerHTML='';
            rec.sourceCheckPatches=null;rec.sourcePatches=null;rec.visibleRemovedSources=null;
            rec.objects.forEach(o=>{delete o.sourceHitIndex;delete o.sourceImageHitIndex;});
          }
        }
      },{rootMargin:'500px 0px'});
      for(let i=1;i<=pdfDoc.numPages;i++){await renderPage(i);setBusy(true,`Preparing page ${i} of ${pdfDoc.numPages}…`,70+25*i/pdfDoc.numPages);}
      currentPage=pageOrder[0];setPagePanelOpen(true);fitDocument();await hydratePage(pageRecords.get(currentPage));
      updatePageNumbers();resetHistory();refreshLayers();
    }
    async function releaseDocument(){
      documentGeneration++;pageObserver?.disconnect();pageObserver=null;
      for(const entry of sourcePdfFonts.values())document.fonts.delete(entry.face);sourcePdfFonts.clear();sourceFontLoads.clear();sourceFontDocument=null;sourceFontSerial=0;
      if(engineWorker){engineWorker.terminate();engineWorker=null;engineReady=null;rejectEngineRequests(new Error('Document closed.'));}
      thumbnailObserver?.disconnect();
      for(const rec of pageBank.values()){clearTimeout(rec.thumbTimer);clearTimeout(rec.previewTimer);rec.renderTask?.cancel();rec.canvas.width=rec.canvas.height=1;}
      if(pdfDoc)await pdfDoc.destroy();pdfDoc=null;originalBytes=null;
      workspace.replaceChildren();pageRecords.clear();pageBank.clear();pageOrder=[];history=[];redoHistory=[];committedState=null;savedSignature='';
      selected=null;currentPage=null;zoom=1;renderQueue=Promise.resolve();
      layersOpen=false;layersPanel.classList.add('hidden');toggleLayersBtn.classList.remove('active');
      $('#pageThumbnails').replaceChildren();afterDownload.classList.add('hidden');
    }


    async function renderPage(pageNum){
      const page=await pdfDoc.getPage(pageNum),key='orig_'+pageNum;
      const rec=createPageScaffold(key,page.getViewport({scale:1.45}),page.getViewport({scale:1}));
      rec.page=page;rec.originalPageNum=pageNum;rec.isBlank=false;rec.rotation=0;
      pageRecords.set(key,rec);pageBank.set(key,rec);pageOrder.push(key);workspace.appendChild(rec.holder);
      rec.holder.dataset.page=key;addPageInsertControls(rec);setupPagePointer(rec);updatePageZoom(rec);
      rec.textLayer.style.pointerEvents=activeTool==='text'?'auto':'none';
      rec.imageHitLayer.style.pointerEvents=activeTool==='image'?'auto':'none';
      pageObserver?.observe(rec.holder);
    }
    function hydratePage(rec){
      if(!rec||rec.isBlank||rec.hydrated)return Promise.resolve();
      if(rec.hydrating)return rec.hydrating;
      const generation=documentGeneration;
      rec.hydrating=renderQueue=renderQueue.catch(()=>{}).then(async()=>{
        if(generation!==documentGeneration||!pageRecords.has(rec.pageNum))return;
        const v=rec.viewport,dpr=Math.min(window.devicePixelRatio||1,1.5,Math.sqrt(2400000/(v.width*v.height)));
        rec.renderDpr=dpr;rec.canvas.width=Math.ceil(v.width*dpr);rec.canvas.height=Math.ceil(v.height*dpr);
        const ctx=rec.canvas.getContext('2d',{alpha:false});
        rec.renderTask=rec.page.render({canvasContext:ctx,viewport:v,transform:[dpr,0,0,dpr,0,0]});
        await rec.renderTask.promise;rec.renderTask=null;
        rec.textLayer.replaceChildren();rec.imageHitLayer.replaceChildren();
        await buildTextHitLayer(rec);await buildImageHitLayer(rec);await prepareInstantTextPreview(rec);rec.hydrated=true;rec.previewSignature=JSON.stringify({...jobForPage(rec),items:[],images:[]});rec.textLayer.style.pointerEvents=activeTool==='text'?'auto':'none';rec.imageHitLayer.style.pointerEvents=activeTool==='image'?'auto':'none';
        rec.objects.forEach(o=>{
          if(o.cover){const hit=[...rec.textLayer.children].find(x=>x.dataset.sourceIndex===String(o.sourceItemIndex));if(hit){o.sourceHitIndex=[...rec.textLayer.children].indexOf(hit);hit.style.pointerEvents='none';}}
        });
        if(!rec.thumbnail){const c=document.createElement('canvas');c.width=100;c.height=Math.round(100*v.height/v.width);c.getContext('2d').drawImage(rec.canvas,0,0,c.width,c.height);rec.thumbnail=c.toDataURL('image/png');updateThumbnailImage(rec);}
        requestSourceTextPreview(rec);
      }).catch(e=>{if(generation===documentGeneration && e.name!=='RenderingCancelledException')showError(e,'Unable to render a page');}).finally(()=>{rec.hydrating=null;});
      return rec.hydrating;
    }


    function renderImageLibrary(){
      if(!savedImagesBox) return;
      savedImagesBox.innerHTML='';
      if(!imageLibrary.length){
        const empty=document.createElement('div');
        empty.className='image-chip empty';
        empty.textContent='Uploaded images will appear here';
        savedImagesBox.appendChild(empty);
        return;
      }
      imageLibrary.forEach((item,idx)=>{
        const btn=document.createElement('button');
        btn.type='button';
        btn.className='image-chip';
        btn.dataset.index=String(idx);
        btn.title='Add this image again';
        btn.innerHTML=`<img src="${item.src}" alt=""><span>${escapeHtml(item.name||('Image '+(idx+1)))}</span>`;
        btn.addEventListener('click',()=>addImageFromLibrary(idx));
        savedImagesBox.appendChild(btn);
      });
    }

    function rememberImageAsset(src,name='Image'){
      if(!src) return;
      if(imageLibrary.some(item=>item.src===src)) return;
      imageLibrary.unshift({src,name});
      renderImageLibrary();
    }

    function fitDefaultImageSize(rec,img){
      const sideways=(rec.rotation||0)%180;
      const displayW=sideways?rec.viewport.height:rec.viewport.width,displayH=sideways?rec.viewport.width:rec.viewport.height;
      const maxW=Math.min(displayW*.45,320);
      const ratio=(img && img.naturalWidth && img.naturalHeight)?(img.naturalWidth/img.naturalHeight):1;
      let w=maxW,h=maxW/(ratio||1);
      if(h>displayH*.45){h=Math.min(displayH*.45,260);w=h*(ratio||1)}
      return {w,h};
    }

    function addImageFromSource(src,name='Image',recordHistory=true){
      const rec=pageRecords.get(currentPage)||pageRecords.get(pageOrder[0]);
      if(!rec||!src)return;
      const img=new Image();
      const generation=documentGeneration;
      img.onload=()=>{
        if(generation!==documentGeneration)return;
        if(img.naturalWidth*img.naturalHeight>24000000){showError('This image has too many pixels. Use an image smaller than 24 megapixels.');return;}
        const size=fitDefaultImageSize(rec,img);
        const angle=newObjectAngle(rec),offset=rotateVector(size.w/2,size.h/2,angle);
        const obj={id:uid(),type:'image',x:rec.viewport.width/2-offset.x,y:rec.viewport.height/2-offset.y,angle,w:size.w,h:size.h,src,naturalWidth:img.naturalWidth||size.w,naturalHeight:img.naturalHeight||size.h,name};
        addObject(rec,obj,recordHistory);
        selectObject(rec.pageNum,obj.id);
        setActiveTool('image');
      };
      img.onerror=()=>showError('This image could not be opened. Use PNG, JPEG or WebP.');img.src=src;
    }

    function addImageFromLibrary(index){
      const item=imageLibrary[index];
      if(!item)return;
      addImageFromSource(item.src,item.name,true);
      showToast('Image added again from your uploaded images.');
    }

    function objectLabel(obj){
      if(!obj) return 'Object';
      if(obj.type==='text'){
        const raw=(obj.originalText && obj.cover && obj.deleted)?obj.originalText:(obj.text||obj.originalText||'Text');
        const label=String(raw).replace(/\s+/g,' ').trim() || 'Text';
        return (obj.cover?'PDF text: ':'Text: ') + label.slice(0,26);
      }
      if(obj.type==='image') return obj.name ? `Image: ${String(obj.name).slice(0,22)}` : 'Added image';
      if(obj.type==='source-image') return obj.deleted ? 'Deleted PDF image' : 'PDF image';
      if(obj.type==='shape') return obj.kind==='circle'?'Circle / Oval':'Rectangle';
      return obj.type;
    }

    function syncLayerOrder(rec){
      if(!rec) return;
      rec.objects.forEach((obj,idx)=>{
        const sc=rec.objectLayer.querySelector(`.pdf-source-cover[data-for="${obj.id}"]`);
        if(sc){
          sc.style.zIndex=String(9+idx*3);
          rec.objectLayer.appendChild(sc);
        }
        const el=rec.objectLayer.querySelector(`[data-id="${obj.id}"]`);
        if(el){
          el.style.zIndex=String(10+idx*3);
          rec.objectLayer.appendChild(el);
        }
        const mh=rec.objectLayer.querySelector(`.text-move-handle[data-for="${obj.id}"]`);
        if(mh){
          mh.style.zIndex=String(11+idx*3);
          rec.objectLayer.appendChild(mh);
        }
      });
      requestSourceTextPreview(rec);
      refreshLayers(rec.pageNum);
    }

    function refreshLayers(pageNum=currentPage){
      if(!layersList||!layersEmpty||!layersSub) return;
      const rec=pageRecords.get(pageNum||currentPage||pageOrder[0]);
      currentPage = rec ? rec.pageNum : currentPage;markActiveThumbnail();
      layersList.innerHTML='';
      if(!rec){
        layersEmpty.classList.remove('hidden');
        layersSub.textContent='No page selected';
        return;
      }
      layersSub.textContent=`Page ${Math.max(1,pageOrder.indexOf(rec.pageNum)+1)} — top layer first`;
      if(!rec.objects.length){
        layersEmpty.classList.remove('hidden');
        return;
      }
      layersEmpty.classList.add('hidden');
      [...rec.objects].reverse().forEach((obj,revIdx)=>{
        const idx=rec.objects.length-1-revIdx;
        const row=document.createElement('div');
        row.className='layer-item'+(selected&&selected.pageNum===rec.pageNum&&selected.id===obj.id?' active':'');
        row.dataset.id=obj.id;
        row.innerHTML=`<span class="layer-badge">${obj.type==='text'?'TEXT':obj.type==='image'?'IMG':obj.type==='shape'?'SHAPE':'PDF'}</span><div class="layer-name">${escapeHtml(objectLabel(obj))}</div><div class="layer-actions"><button type="button" data-act="up" title="Bring forward">↑</button><button type="button" data-act="down" title="Send backward">↓</button><button type="button" class="danger" data-act="delete" title="Delete">✕</button></div>`;
        row.addEventListener('click',ev=>{
          const act=ev.target.closest('button')?.dataset.act;
          if(act){
            ev.stopPropagation();
            if(act==='up' && idx<rec.objects.length-1){
              const temp=rec.objects[idx+1];rec.objects[idx+1]=rec.objects[idx];rec.objects[idx]=temp;syncLayerOrder(rec);selectObject(rec.pageNum,obj.id);commitHistory();
            }else if(act==='down' && idx>0){
              const temp=rec.objects[idx-1];rec.objects[idx-1]=rec.objects[idx];rec.objects[idx]=temp;syncLayerOrder(rec);selectObject(rec.pageNum,obj.id);commitHistory();
            }else if(act==='delete'){
              selectObject(rec.pageNum,obj.id);deleteSelected();
            }
            return;
          }
          selectObject(rec.pageNum,obj.id);
        });
        layersList.appendChild(row);
      });
    }

    function createPageScaffold(pageKey, viewport, unitViewport){
      const holder = document.createElement('div');
      holder.className='page-holder';
      const shell = document.createElement('div');
      shell.className='page-shell';
      shell.dataset.page = pageKey;
      shell.style.width = viewport.width+'px';
      shell.style.height = viewport.height+'px';

      const canvas = document.createElement('canvas');
      canvas.className='pdf-canvas';canvas.width=canvas.height=1;
      canvas.style.width=viewport.width+'px'; canvas.style.height=viewport.height+'px';
      const textLayer = document.createElement('div');
      textLayer.className='text-hit-layer';
      const imageHitLayer = document.createElement('div');
      imageHitLayer.className='image-hit-layer';
      const objectLayer = document.createElement('div');
      objectLayer.className='object-layer';
      const num = document.createElement('div'); num.className='page-number';
      const actions=document.createElement('div');actions.className='page-actions';actions.append(num);
      shell.append(canvas,textLayer,imageHitLayer,objectLayer);holder.append(shell,actions);
      return {rotation:0,hydrated:false,pageNum:pageKey,page:null,originalPageNum:null,isBlank:false,viewport,unitViewport,holder,shell,canvas,textLayer,imageHitLayer,objectLayer,pageNumber:num,objects:[]};
    }

    function addPageInsertControls(rec){
      const above=document.createElement('button');above.className='page-add-btn above';above.type='button';above.textContent='+ Empty page above';
      const below=document.createElement('button');below.className='page-add-btn below';below.type='button';below.textContent='+ Empty page below';
      const del=document.createElement('button');del.className='page-delete-btn';del.type='button';del.textContent='Delete page';
      above.addEventListener('click',()=>insertBlankPage(rec.pageNum,'above',true));
      below.addEventListener('click',()=>insertBlankPage(rec.pageNum,'below',true));del.addEventListener('click',()=>deletePage(rec.pageNum,true));
      const left=document.createElement('button'),right=document.createElement('button');
      left.className=right.className='prop-btn page-rotate-btn';
      left.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/></svg><span class="rotate-full">Rotate Left 90°</span><span class="rotate-short">Left 90°</span>';
      right.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 10a9 9 0 1 0-2 8M21 4v6h-6"/></svg><span class="rotate-full">Rotate Right 90°</span><span class="rotate-short">Right 90°</span>';
      left.title=left.ariaLabel='Rotate left 90°';right.title=right.ariaLabel='Rotate right 90°';
      left.addEventListener('click',()=>rotatePage(rec,-90));right.addEventListener('click',()=>rotatePage(rec,90));
      const rotations=document.createElement('div');rotations.className='page-rotations';rotations.append(left,right);
      rec.holder.querySelector('.page-actions').append(del,rotations);rec.holder.append(above,below);
    }
    function rotatePage(rec,degrees){
      finishTextEditing();rec.rotation=((rec.rotation||0)+degrees+360)%360;fitDocument();refreshThumbnails();commitHistory();
    }


    function deletePage(pageKey,recordHistory=true){
      if(pageOrder.length<=1){showToast('At least one page must remain in the PDF.');return;}
      const rec=pageRecords.get(pageKey); if(!rec)return;
      const idx=pageOrder.indexOf(pageKey); if(idx<0)return;
      const wasSelected=!!(selected&&selected.pageNum===pageKey);
      const wasCurrent=currentPage===pageKey;
      pageOrder.splice(idx,1);
      pageRecords.delete(pageKey);
      rec.holder.remove();
      if(wasSelected)clearSelection();
      if(wasCurrent||!pageRecords.get(currentPage)) currentPage=pageOrder[Math.min(idx,pageOrder.length-1)]||pageOrder[0]||null;
      updatePageNumbers();
      refreshLayers(currentPage);
      if(recordHistory){
        commitHistory();
        updateUndoState();
      }
      showToast('Page deleted. Press Ctrl+Z or Undo to restore it.');
    }

    function restoreDeletedPage(rec,index){
      if(!rec||pageRecords.has(rec.pageNum))return;
      const insertIndex=clamp(index,0,pageOrder.length);
      const nextKey=pageOrder[insertIndex]||null;
      pageOrder.splice(insertIndex,0,rec.pageNum);
      pageRecords.set(rec.pageNum,rec);
      if(nextKey&&pageRecords.get(nextKey))workspace.insertBefore(rec.holder,pageRecords.get(nextKey).holder); else workspace.appendChild(rec.holder);
      updatePageZoom(rec);
      updatePageNumbers();
      currentPage=rec.pageNum;
      requestSourceTextPreview(rec);
      refreshLayers(rec.pageNum);
    }

    function insertBlankPage(referenceKey, where='below', recordHistory=true){
      if(pageOrder.length>=MAX_PAGES){showError('Maximum supported length is 200 pages. Delete a page before inserting another.');return;}
      const ref=pageRecords.get(referenceKey); if(!ref)return;
      const refIndex=pageOrder.indexOf(referenceKey);
      const insertIndex=Math.max(0,refIndex+(where==='below'?1:0));
      const pageKey='blank_'+uid();
      const viewport={width:ref.viewport.width,height:ref.viewport.height,scale:ref.viewport.scale||1.45};
      const unitViewport={width:ref.unitViewport.width,height:ref.unitViewport.height,scale:1};
      const rec=createPageScaffold(pageKey,viewport,unitViewport);
      rec.isBlank=true;
      rec.canvas.width=rec.canvas.height=1;
      const ctx=rec.canvas.getContext('2d',{alpha:false});ctx.fillStyle='#ffffff';ctx.fillRect(0,0,1,1);
      const nextKey=pageOrder[insertIndex]||null;
      pageOrder.splice(insertIndex,0,pageKey); pageRecords.set(pageKey,rec);pageBank.set(pageKey,rec);
      if(nextKey&&pageRecords.get(nextKey))workspace.insertBefore(rec.holder,pageRecords.get(nextKey).holder); else workspace.appendChild(rec.holder);
      addPageInsertControls(rec); setupPagePointer(rec); updatePageZoom(rec); updatePageNumbers(); currentPage=pageKey;markActiveThumbnail();
      fitPageWidthsIfNeeded();
      if(recordHistory){
        commitHistory(); updateUndoState();
      }
      showToast(where==='above'?'Empty page added above.':'Empty page added below.');
      return rec;
    }

    function removeInsertedPage(pageKey){
      const rec=pageRecords.get(pageKey); if(!rec||!rec.isBlank)return;
      const idx=pageOrder.indexOf(pageKey); if(idx>=0)pageOrder.splice(idx,1);
      rec.holder.remove(); pageRecords.delete(pageKey);
      if(selected&&selected.pageNum===pageKey)clearSelection();
      if(currentPage===pageKey)currentPage=pageOrder[Math.max(0,idx-1)]||pageOrder[0]||null;
      updatePageNumbers();
    }

    function updatePageControls(){
      const lastIndex=pageOrder.length-1;
      pageOrder.forEach((key,i)=>{
        const rec=pageRecords.get(key);if(!rec)return;
        const above=rec.holder.querySelector('.page-add-btn.above');
        const below=rec.holder.querySelector('.page-add-btn.below');
        // One insertion control per gap: every page owns the gap immediately above it.
        // Only the final page also owns the outside-bottom insertion point.
        if(above)above.classList.remove('control-hidden');
        if(below)below.classList.toggle('control-hidden',i!==lastIndex);
      });
    }

    function updatePageNumbers(){
      pageOrder.forEach((key,i)=>{const rec=pageRecords.get(key);if(rec&&rec.pageNumber)rec.pageNumber.textContent=i+1});
      updatePageControls();refreshThumbnails();
    }

    async function buildTextHitLayer(rec){
      const tc = await rec.page.getTextContent();
      const styles = tc.styles || {};
      const coincidentHits=new Map();
      let sourceIndex=-1;
      for (const item of tc.items) {
        sourceIndex++;
        if (!item.str || !item.str.trim()) continue;
        const tx = pdfjsLib.Util.transform(rec.viewport.transform, item.transform);
        const angle = Math.atan2(tx[1], tx[0]);
        const fontSize = Math.hypot(tx[2],tx[3]);
        const style = styles[item.fontName] || {};
        const ascent = Number.isFinite(style.ascent) ? style.ascent : (Number.isFinite(style.descent) ? 1+style.descent : .8);
        const left = tx[4];
        const top = tx[5] - fontSize * ascent;
        const width = Math.max(6, (item.width || item.str.length*fontSize*.5) * rec.viewport.scale);
        const height = Math.max(fontSize*1.02, 8);
        const key=item.str.normalize('NFKC'),previous=coincidentHits.get(key)||[];
        if(previous.some(p=>Math.hypot(p.x-tx[4],p.y-tx[5])<.2*rec.viewport.scale&&Math.abs(p.size-fontSize)<.2&&Math.abs(p.width-width)<.4))continue;
        previous.push({x:tx[4],y:tx[5],size:fontSize,width});coincidentHits.set(key,previous);
        let fontFamily = style.fontFamily || 'Arial, sans-serif';
        let renderFont=compatibleFont(fontFamily),spanFontName='';
        let fontWeight = '400';
        let fontStyle = 'normal';
        try{
          const fo = rec.page.commonObjs && rec.page.commonObjs.get ? rec.page.commonObjs.get(item.fontName) : null;
          if (fo) {
            ensureEditorFont(fo.name||style.fontFamily).catch(()=>{});
            if (fo.loadedName) fontFamily = '"'+fo.loadedName+'", '+fontFamily;
            const name=fo.name||'';
            spanFontName=name;
            renderFont=compatibleFont(name||fontFamily);
            if (fo.black || fo.bold || /bold|black/i.test(name)) fontWeight = fo.black ? '900' : '700';
            if (fo.italic || /italic|oblique/i.test(name)) fontStyle='italic';
          }
        }catch(_){ }
        const span = document.createElement('span');
        span.className='text-hit';
        span.textContent=item.str;
        span.dataset.pdfPoint=JSON.stringify(item.transform.slice(4,6));span.dataset.sourceIndex=sourceIndex;span.dataset.baseline=JSON.stringify([tx[4],tx[5]]);span.dataset.angle=angle;
        span.dataset.font = fontFamily;
        span.dataset.renderFont=renderFont;
        span.dataset.pdfFontName=spanFontName;
        span.dataset.size = fontSize.toFixed(2);
        span.dataset.weight = fontWeight;
        span.dataset.style = fontStyle;
        // A thin band through the middle of the glyphs identifies the whole
        // PDF characters. Full font boxes often overlap a neighboring line.
        const dx=Math.cos(angle),dy=Math.sin(angle),nx=dy,ny=-dx;
        const point=(along,up)=>[tx[4]+dx*along+nx*up,tx[5]+dy*along+ny*up];
        const inset=Math.min(.15,width*.02);
        span.dataset.redactQuad=JSON.stringify([
          ...point(inset,fontSize*.55),...point(width-inset,fontSize*.55),
          ...point(inset,fontSize*.45),...point(width-inset,fontSize*.45)
        ]);
        span.style.left=left+'px'; span.style.top=top+'px'; span.style.width=width+'px'; span.style.height=height+'px';
        span.style.fontFamily=fontFamily; span.style.fontSize=fontSize+'px'; span.style.fontWeight=fontWeight; span.style.fontStyle=fontStyle;
        if (Math.abs(angle)>.001) span.style.transform=`rotate(${angle}rad)`;
        span.addEventListener('pointerdown', e => {
          if (activeTool!=='text') return;
          e.stopPropagation();e.preventDefault();
          currentPage=rec.pageNum;
          editExistingText(rec,span,e);
        });
        rec.textLayer.appendChild(span);
      }
    }

    async function buildImageHitLayer(rec){
      const opList=await rec.page.getOperatorList();
      const OPS=pdfjsLib.OPS;
      let ctm=[1,0,0,1,0,0], stack=[],imageOrdinal=-1;
      const imageOccurrences=new Map();
      const isImageOp = fn => fn===OPS.paintImageXObject || fn===OPS.paintInlineImageXObject || fn===OPS.paintJpegXObject;
      const mul=(a,b)=>pdfjsLib.Util.transform(a,b);
      for(let i=0;i<opList.fnArray.length;i++){
        const fn=opList.fnArray[i], args=opList.argsArray[i]||[];
        if(fn===OPS.save){stack.push(ctm.slice());continue}
        if(fn===OPS.restore){ctm=stack.pop()||ctm;continue}
        if(fn===OPS.transform){ctm=mul(ctm,args);continue}
        if(fn===OPS.paintFormXObjectBegin){stack.push(ctm.slice());if(args[0])ctm=mul(ctm,args[0]);continue}
        if(fn===OPS.paintFormXObjectEnd){ctm=stack.pop()||ctm;continue}
        if(!isImageOp(fn))continue;
        imageOrdinal++;
        try{
          const apply=(p,m)=>[m[0]*p[0]+m[2]*p[1]+m[4],m[1]*p[0]+m[3]*p[1]+m[5]];
          const pdfCorners=[[0,0],[1,0],[0,1],[1,1]].map(p=>apply(p,ctm));
          const pdfQuad=pdfCorners.flat(),imageKey=pdfQuad.map(n=>n.toFixed(2)).join('|');
          const sourceImageOccurrence=imageOccurrences.get(imageKey)||0;imageOccurrences.set(imageKey,sourceImageOccurrence+1);
          const corners=pdfCorners.map(p=>apply(p,rec.viewport.transform));
          const xs=corners.map(p=>p[0]), ys=corners.map(p=>p[1]);
          let x=Math.min(...xs), y=Math.min(...ys), w=Math.max(...xs)-x, h=Math.max(...ys)-y;
          if(w<8||h<8||w*h<100)continue;
          x=clamp(x,0,rec.viewport.width); y=clamp(y,0,rec.viewport.height);
          w=Math.min(w,rec.viewport.width-x); h=Math.min(h,rec.viewport.height-y);
          const hit=document.createElement('div');
          hit.className='image-hit';
          Object.assign(hit.style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px'});
          hit.dataset.x=x;hit.dataset.y=y;hit.dataset.w=w;hit.dataset.h=h;
          hit.dataset.pdfQuad=JSON.stringify(pdfQuad);hit.dataset.occurrence=String(sourceImageOccurrence);hit.dataset.opIndex=String(i);
          if(typeof args[0]==='string')hit.dataset.imageId=args[0];
          hit.dataset.imageOrdinal=imageOrdinal;
          const existing=rec.objects.find(o=>o.type==='source-image'&&nearEqual(o.x,x)&&nearEqual(o.y,y)&&nearEqual(o.w,w)&&nearEqual(o.h,h)&&(o.sourceImageOccurrence==null||o.sourceImageOccurrence===sourceImageOccurrence));
          if(existing){hit.dataset.objId=existing.id;existing.sourceImageHitIndex=rec.imageHitLayer.children.length;hit.style.pointerEvents=existing.deleted?'none':'inherit';}
          hit.addEventListener('pointerdown',e=>{
            if(activeTool!=='image')return;
            e.stopPropagation();e.preventDefault();currentPage=rec.pageNum;
            selectExistingImage(rec,hit);
          });
          rec.imageHitLayer.appendChild(hit);
        }catch(_){ }
      }
      // Large background images must not intercept clicks on smaller photos.
      [...rec.imageHitLayer.children].sort((a,b)=>(+b.dataset.w*+b.dataset.h)-(+a.dataset.w*+a.dataset.h)||(+a.dataset.opIndex)-(+b.dataset.opIndex)).forEach(hit=>rec.imageHitLayer.appendChild(hit));
      syncSourceImageHits(rec);
    }

    function syncSourceImageHits(rec){
      [...rec.imageHitLayer.children].forEach((hit,index)=>{
        const quad=JSON.parse(hit.dataset.pdfQuad),occurrence=+hit.dataset.occurrence;
        const obj=rec.objects.find(o=>o.type==='source-image'&&o.id===hit.dataset.objId)||rec.objects.find(o=>o.type==='source-image'&&(o.sourceImageOccurrence==null||o.sourceImageOccurrence===occurrence)&&(o.sourcePdfQuad?o.sourcePdfQuad.every((v,i)=>nearEqual(v,quad[i],.02)):nearEqual(o.x,+hit.dataset.x)&&nearEqual(o.y,+hit.dataset.y)&&nearEqual(o.w,+hit.dataset.w)&&nearEqual(o.h,+hit.dataset.h)));
        if(obj){hit.dataset.objId=obj.id;obj.sourceImageHitIndex=index;}
        else delete hit.dataset.objId;
        // Inherit the layer's active tool state. An explicit "auto" here would
        // make this child clickable even when its parent has pointer-events:none,
        // intercepting the text layer beneath large PDF background images.
        hit.style.pointerEvents=obj?.deleted?'none':'inherit';
      });
    }

    function selectExistingImage(rec,hit){
      let obj=hit.dataset.objId ? rec.objects.find(o=>o.id===hit.dataset.objId) : null;
      if(!obj){
        obj={id:uid(),type:'source-image',x:+hit.dataset.x,y:+hit.dataset.y,w:+hit.dataset.w,h:+hit.dataset.h,deleted:false,sourcePdfQuad:JSON.parse(hit.dataset.pdfQuad),sourceImageOccurrence:+hit.dataset.occurrence,sourceImageHitIndex:[...rec.imageHitLayer.children].indexOf(hit)};
        rec.objects.push(obj);renderObject(rec,obj);hit.dataset.objId=obj.id;commitHistory();
      }
      obj.sourcePdfQuad=JSON.parse(hit.dataset.pdfQuad);obj.sourceImageOccurrence=+hit.dataset.occurrence;
      selectObject(rec.pageNum,obj.id);
      showToast('Existing PDF image selected. Use Delete image to remove it from the PDF.');
    }

    function setupPagePointer(rec){
      rec.shell.addEventListener('pointerdown', e => {
        currentPage = rec.pageNum;
        if (e.target.closest('.editor-object')) return;
        if (activeTool==='shape' && shapeDrawArmed) {
          e.preventDefault();
          beginDraw(rec,e,defaultShapeKind);
          return;
        }
        if (activeTool==='addtext') {
          e.preventDefault();
          const p = pagePoint(rec,e);
          const obj = {
            id:uid(),type:'text',x:p.x,y:p.y,angle:newObjectAngle(rec),w:190,h:textDefaults.fontSize*1.45,
            text:'Click here to edit text',fontSize:textDefaults.fontSize,color:textDefaults.color,
            fontFamily:textDefaults.fontFamily,fontWeight:textDefaults.bold?'700':'400',fontStyle:'normal',underline:!!textDefaults.underline,cover:false,minCoverW:0,minCoverH:0,deleted:false,isPlaceholder:true
          };
          addObject(rec,obj,true);
          selectObject(rec.pageNum,obj.id);
          startTextEditing(rec,obj,null);
          setActiveTool('select');
          showToast('Text added. Type, press Enter, then use the top-left move button to change its position.');
        } else if (!e.target.closest('.text-hit')) {
          clearSelection();
        }
      });
    }

    function pagePoint(rec,e){
      const r=rec.shell.getBoundingClientRect(),x=(e.clientX-r.left)/zoom,y=(e.clientY-r.top)/zoom,w=rec.viewport.width,h=rec.viewport.height;
      const p=rec.rotation===90?{x:y,y:h-x}:rec.rotation===180?{x:w-x,y:h-y}:rec.rotation===270?{x:w-y,y:x}:{x,y};
      return {x:clamp(p.x,0,w),y:clamp(p.y,0,h)};
    }

    // New content follows the visible page axes at the time it is added.
    // Store its orientation in page coordinates so later rotations and undo work normally.
    function newObjectAngle(rec){return -(rec.rotation||0)*Math.PI/180;}
    function rotateVector(x,y,angle=0){const c=Math.cos(angle),s=Math.sin(angle);return {x:c*x-s*y,y:s*x+c*y};}
    function objectOffsets(obj){
      const corners=[[0,0],[obj.w,0],[0,obj.h],[obj.w,obj.h]].map(([x,y])=>rotateVector(x,y,obj.angle||0));
      return {minX:Math.min(...corners.map(p=>p.x)),maxX:Math.max(...corners.map(p=>p.x)),minY:Math.min(...corners.map(p=>p.y)),maxY:Math.max(...corners.map(p=>p.y))};
    }


    function beginDraw(rec,e,type){
      const start=pagePoint(rec,e);
      const preview=document.createElement('div');
      preview.className='drawing-preview'+(type==='circle'?' circle':'');
      preview.style.left=start.x+'px'; preview.style.top=start.y+'px'; preview.style.width='1px';preview.style.height='1px';
      rec.shell.appendChild(preview);
      const id=e.pointerId; rec.shell.setPointerCapture(id);
      function move(ev){
        const p=pagePoint(rec,ev); const x=Math.min(start.x,p.x), y=Math.min(start.y,p.y), w=Math.abs(p.x-start.x),h=Math.abs(p.y-start.y);
        Object.assign(preview.style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px'});
      }
      function up(ev){
        rec.shell.removeEventListener('pointermove',move); rec.shell.removeEventListener('pointerup',up); rec.shell.removeEventListener('pointercancel',up);
        try{rec.shell.releasePointerCapture(id)}catch(_){}
        const p=pagePoint(rec,ev); const x=Math.min(start.x,p.x), y=Math.min(start.y,p.y), w=Math.max(8,Math.abs(p.x-start.x)), h=Math.max(8,Math.abs(p.y-start.y));
        preview.remove();if(ev.type==='pointercancel'||Math.hypot(p.x-start.x,p.y-start.y)<6){shapeDrawArmed=false;setActiveTool('select');return;}
        const obj={id:uid(),type:'shape',kind:(type==='circle'?'circle':'rectangle'),x,y,w,h,fill:defaultShapeFill,border:defaultShapeBorder,borderWidth:defaultShapeBorderWidth};
        addObject(rec,obj,true); selectObject(rec.pageNum,obj.id);
        shapeDrawArmed=false; setActiveTool('select');
      }
      rec.shell.addEventListener('pointermove',move); rec.shell.addEventListener('pointerup',up); rec.shell.addEventListener('pointercancel',up);
    }

    function rgbHex(r,g,b){
      return '#'+[r,g,b].map(v=>clamp(Math.round(v),0,255).toString(16).padStart(2,'0')).join('');
    }

    function parseHexRgb(hex){
      const h=normalizeHex(hex,'#ffffff').slice(1);
      return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];
    }

    function analyzeTextBackground(rec,x,y,w,h){
      try{
        const ctx=rec.canvas.getContext('2d');
        const sx=rec.canvas.width/rec.viewport.width, sy=rec.canvas.height/rec.viewport.height;
        const left=Math.max(0,Math.floor(x*sx)), top=Math.max(0,Math.floor(y*sy));
        const right=Math.min(rec.canvas.width,Math.ceil((x+w)*sx)), bottom=Math.min(rec.canvas.height,Math.ceil((y+h)*sy));
        const padX=Math.max(3,Math.round(3*sx)), padY=Math.max(3,Math.round(3*sy));
        const ex0=Math.max(0,left-padX), ey0=Math.max(0,top-padY);
        const ex1=Math.min(rec.canvas.width,right+padX), ey1=Math.min(rec.canvas.height,bottom+padY);
        const ew=Math.max(1,ex1-ex0), eh=Math.max(1,ey1-ey0);
        const data=ctx.getImageData(ex0,ey0,ew,eh).data;
        const buckets=new Map();
        const samples=[];
        const step=Math.max(1,Math.floor(Math.min(sx,sy)));
        for(let yy=0;yy<eh;yy+=step){
          for(let xx=0;xx<ew;xx+=step){
            const gx=ex0+xx, gy=ey0+yy;
            const i=(yy*ew+xx)*4, a=data[i+3]; if(a<220)continue;
            const r=data[i],g=data[i+1],b=data[i+2];
            const qr=Math.round(r/6)*6, qg=Math.round(g/6)*6, qb=Math.round(b/6)*6;
            const key=`${clamp(qr,0,255)},${clamp(qg,0,255)},${clamp(qb,0,255)}`;
            const inside=(gx>=left&&gx<right&&gy>=top&&gy<bottom);
            // Most pixels inside a text box are still background. Weight them,
            // but also sample the surrounding ring so a coloured/grey cell wins
            // instead of nearby white page space.
            const weight=inside?2.25:1;
            buckets.set(key,(buckets.get(key)||0)+weight);
            samples.push([r,g,b,key]);
          }
        }
        let best='255,255,255', score=-1,total=0;
        for(const [k,v] of buckets){total+=v;if(v>score){best=k;score=v}}
        const dominance=total>0?score/total:0;
        const [cr,cg,cb]=best.split(',').map(Number);
        const close=[];
        for(const [r,g,b] of samples){
          if(Math.hypot(r-cr,g-cg,b-cb)<=11) close.push([r,g,b]);
        }
        if(close.length){
          const med=idx=>{const a=close.map(v=>v[idx]).sort((a,b)=>a-b);return a[Math.floor(a.length/2)]};
          const r=med(0),g=med(1),b=med(2);
          const veryClose=close.filter(v=>Math.hypot(v[0]-r,v[1]-g,v[2]-b)<=7).length;
          const confidence=samples.length?veryClose/samples.length:0;
          // Dense bold headings can cover most of a shallow coloured bar, and
          // the padded ring also includes the white page outside that bar.
          // Matching flat rows above AND below the glyphs provide independent
          // evidence of a solid background without lowering the photo guard.
          let flatAbove=false,flatBelow=false;
          const mid=(top+bottom)/2,rowWidth=right-left;
          if(rowWidth>=12){
            // Font ascent boxes can end one pixel above a clean baseline row,
            // or start on the cell border. Include the existing narrow ring.
            for(let gy=ey0;gy<ey1;gy++){
              let matching=0;
              for(let gx=left;gx<right;gx++){
                const i=((gy-ey0)*ew+gx-ex0)*4;
                if(data[i+3]>=220&&Math.max(Math.abs(data[i]-r),Math.abs(data[i+1]-g),Math.abs(data[i+2]-b))<=7)matching++;
              }
              // A narrow cell rule or a separate vector watermark may cross a
              // small part of an otherwise solid background band.
              if(matching>=rowWidth*.8){if(gy<mid)flatAbove=true;else flatBelow=true;}
            }
          }
          // Ordinary PDF cells/pages are usually one flat colour with dark text
          // drawn on top. Using the dominant background bucket is much more
          // reliable than trying to erase individual antialiased glyph pixels.
          return {color:rgbHex(r,g,b),flat:(confidence>=0.42||dominance>=0.48||(confidence>=.22&&flatAbove&&flatBelow)),confidence,dominance};
        }
        return {color:rgbHex(cr,cg,cb),flat:dominance>=0.48,confidence:0,dominance};
      }catch(_){return {color:'#ffffff',flat:false,confidence:0,dominance:0}}
    }

    function detectTextBackground(rec,x,y,w,h){
      return analyzeTextBackground(rec,x,y,w,h).color;
    }

    function detectTextColor(rec,x,y,w,h,backgroundColor){
      try{
        const ctx=rec.canvas.getContext('2d');
        const sx=rec.canvas.width/rec.viewport.width, sy=rec.canvas.height/rec.viewport.height;
        const ix=Math.max(0,Math.floor(x*sx)), iy=Math.max(0,Math.floor(y*sy));
        const iw=Math.max(1,Math.min(rec.canvas.width-ix,Math.ceil(w*sx))), ih=Math.max(1,Math.min(rec.canvas.height-iy,Math.ceil(h*sy)));
        const data=ctx.getImageData(ix,iy,iw,ih).data;
        const [br,bg,bb]=parseHexRgb(backgroundColor||'#ffffff');
        const buckets=new Map();
        const topCut=Math.floor(ih*.08), bottomCut=Math.ceil(ih*.90);
        for(let yy=topCut;yy<bottomCut;yy++){
          for(let xx=0;xx<iw;xx++){
            const i=(yy*iw+xx)*4, a=data[i+3]; if(a<180)continue;
            const r=data[i],g=data[i+1],b=data[i+2];
            const dr=r-br,dg=g-bg,db=b-bb;
            const dist=Math.sqrt(dr*dr+dg*dg+db*db);
            if(dist<24)continue;
            const qr=Math.round(r/8)*8, qg=Math.round(g/8)*8, qb=Math.round(b/8)*8;
            const key=`${clamp(qr,0,255)},${clamp(qg,0,255)},${clamp(qb,0,255)}`;
            // Prefer solid glyph-core pixels over pale antialiasing. A plain
            // frequency count can incorrectly choose a grey fringe around blue
            // or black text, especially on a coloured background.
            const weight=1+Math.min(5,dist/45);
            buckets.set(key,(buckets.get(key)||0)+weight);
          }
        }
        let best=null,bestScore=-1;
        for(const [k,v] of buckets){if(v>bestScore){best=k;bestScore=v}}
        if(!best)return '#000000';
        const [r,g,b]=best.split(',').map(Number);
        return rgbHex(r,g,b);
      }catch(_){return '#000000'}
    }

    function detectSourceInkTop(rec,x,y,w,h,backgroundColor,textColor){
      try{
        const ctx=rec.canvas.getContext('2d');
        const sx=rec.canvas.width/rec.viewport.width, sy=rec.canvas.height/rec.viewport.height;
        const ix=Math.max(0,Math.floor(x*sx)), iy=Math.max(0,Math.floor(y*sy));
        const iw=Math.max(1,Math.min(rec.canvas.width-ix,Math.ceil(w*sx))), ih=Math.max(1,Math.min(rec.canvas.height-iy,Math.ceil(h*sy)));
        const data=ctx.getImageData(ix,iy,iw,ih).data;
        const [br,bg,bb]=parseHexRgb(backgroundColor||'#ffffff');
        const [tr,tg,tb]=parseHexRgb(textColor||'#000000');
        let minY=ih;
        for(let yy=0;yy<ih;yy++){
          for(let xx=0;xx<iw;xx++){
            const i=(yy*iw+xx)*4;if(data[i+3]<180)continue;
            const r=data[i],g=data[i+1],b=data[i+2];
            const dbgr=Math.hypot(r-br,g-bg,b-bb);
            if(dbgr<18)continue;
            const dtext=Math.hypot(r-tr,g-tg,b-tb);
            if(dtext<=Math.max(90,dbgr*1.35)){minY=Math.min(minY,yy);}
          }
        }
        return minY<ih ? minY/sy : 0;
      }catch(_){return 0}
    }

    function cssTextInkTopOffset(text,fontSize,fontFamily,fontWeight,fontStyle){
      try{
        const ctx=document.createElement('canvas').getContext('2d');
        ctx.font=`${fontStyle||'normal'} ${fontWeight||'400'} ${fontSize}px ${fontFamily||'Arial, sans-serif'}`;
        const m=ctx.measureText(String(text||'Hg'));
        const lineHeight=fontSize*1.16;
        const fba=m.fontBoundingBoxAscent||fontSize*.8;
        const fbd=m.fontBoundingBoxDescent||fontSize*.2;
        const aba=m.actualBoundingBoxAscent||fba;
        const leading=Math.max(0,(lineHeight-(fba+fbd))/2);
        return Math.max(0,leading+fba-aba);
      }catch(_){return 0}
    }

    function detectTextUnderline(rec,x,y,w,h){
      try{
        const ctx=rec.canvas.getContext('2d');
        const sx=rec.canvas.width/rec.viewport.width, sy=rec.canvas.height/rec.viewport.height;
        const x0=Math.max(0,Math.floor(x*sx));
        const x1=Math.min(rec.canvas.width,Math.ceil((x+w)*sx));
        const y0=Math.max(0,Math.floor((y+h*.72)*sy));
        const y1=Math.min(rec.canvas.height,Math.ceil((y+h*1.02)*sy));
        const width=Math.max(1,x1-x0), height=Math.max(1,y1-y0);
        if(width<8||height<1)return false;
        const data=ctx.getImageData(x0,y0,width,height).data;
        // Underlines are usually a long, nearly continuous horizontal run.
        // Looking only near the lower part of the text box avoids most glyph strokes.
        const needed=Math.max(8,Math.floor(width*.42));
        for(let row=0;row<height;row++){
          let run=0,best=0;
          for(let col=0;col<width;col++){
            const i=(row*width+col)*4;
            const a=data[i+3], r=data[i], g=data[i+1], b=data[i+2];
            const ink=a>120 && !(r>225&&g>225&&b>225);
            if(ink){run++; if(run>best)best=run;} else run=0;
          }
          if(best>=needed)return true;
        }
      }catch(_){ }
      return false;
    }

    function detectSourceTextInkRect(rec,x,y,w,h,backgroundColor,textColor,fontSize){
      // Tight rectangle around only the clicked PDF text line. PDF.js hit boxes
      // can be a little taller than the glyphs and may overlap a nearby row.
      try{
        const ctx=rec.canvas.getContext('2d');
        const sx=rec.canvas.width/rec.viewport.width, sy=rec.canvas.height/rec.viewport.height;
        const ix=Math.max(0,Math.floor(x*sx)), iy=Math.max(0,Math.floor(y*sy));
        const iw=Math.max(1,Math.min(rec.canvas.width-ix,Math.ceil(w*sx)));
        const ih=Math.max(1,Math.min(rec.canvas.height-iy,Math.ceil(h*sy)));
        const data=ctx.getImageData(ix,iy,iw,ih).data;
        const [br,bg,bb]=parseHexRgb(backgroundColor||'#ffffff');
        const [tr,tg,tb]=parseHexRgb(textColor||'#000000');
        const vx=tr-br,vy=tg-bg,vz=tb-bb,vv=Math.max(1,vx*vx+vy*vy+vz*vz);
        const rows=new Array(ih).fill(0), longest=new Array(ih).fill(0);
        const ink=new Uint8Array(iw*ih);

        for(let yy=0;yy<ih;yy++){
          let run=0,bestRun=0;
          for(let xx=0;xx<iw;xx++){
            const i=(yy*iw+xx)*4;
            if(data[i+3]<150){run=0;continue}
            const r=data[i],g=data[i+1],b=data[i+2];
            const dx=r-br,dy=g-bg,dz=b-bb;
            const distBg=Math.hypot(dx,dy,dz);
            if(distBg<7){run=0;continue}
            const t=(dx*vx+dy*vy+dz*vz)/vv;
            const ct=clamp(t,0,1.35),cx=br+ct*vx,cy=bg+ct*vy,cz=bb+ct*vz;
            const perp=Math.hypot(r-cx,g-cy,b-cz);
            const dText=Math.hypot(r-tr,g-tg,b-tb);
            const looksLikeText=(t>.02&&t<1.55&&perp<52)||(dText<72&&distBg>10);
            if(looksLikeText){
              ink[yy*iw+xx]=1; rows[yy]++; run++; bestRun=Math.max(bestRun,run);
            }else run=0;
          }
          longest[yy]=bestRun;
        }

        // Ignore long horizontal table rules while finding the line's glyph band.
        const threshold=Math.max(1,Math.floor(iw*.008));
        const active=rows.map((c,i)=>c>=threshold && longest[i]<Math.max(10,iw*.62));
        const groups=[];
        let start=-1,last=-1,gap=0;
        for(let yy=0;yy<ih;yy++){
          if(active[yy]){
            if(start<0)start=yy;
            last=yy;gap=0;
          }else if(start>=0){
            gap++;
            if(gap>1){groups.push([start,last]);start=-1;last=-1;gap=0}
          }
        }
        if(start>=0)groups.push([start,last]);
        if(!groups.length) return {x,y,w,h:Math.min(h,Math.max(8,(fontSize||h)*1.02))};

        // The selected line is the glyph group nearest the centre of its own
        // (now tightly capped) PDF.js hit box; neighbouring rows are ignored.
        const expected=(Math.min(h,Math.max(8,(fontSize||h)*1.02))*sy)*.5;
        let chosen=groups[0],best=Infinity;
        for(const g of groups){
          const dist=Math.abs(((g[0]+g[1])/2)-expected);
          if(dist<best){best=dist;chosen=g}
        }
        let y0=Math.max(0,chosen[0]-1), y1=Math.min(ih-1,chosen[1]+1);
        let x0=iw,x1=-1;
        for(let yy=y0;yy<=y1;yy++) for(let xx=0;xx<iw;xx++) if(ink[yy*iw+xx]){
          x0=Math.min(x0,xx);x1=Math.max(x1,xx);
        }
        if(x1<x0){x0=0;x1=iw-1}
        x0=Math.max(0,x0-1);x1=Math.min(iw-1,x1+1);
        return {x:x+x0/sx,y:y+y0/sy,w:Math.max(2,(x1-x0+1)/sx),h:Math.max(2,(y1-y0+1)/sy)};
      }catch(_){
        return {x,y,w,h:Math.min(h,Math.max(8,(fontSize||h)*1.02))};
      }
    }

    function isolatedSourceLineRect(rec,span,x,y,w,h,fontSize){
      // Build a complete mask for ONLY the clicked PDF text item. We start from
      // the PDF.js span box (which belongs to one text item/line), allow a small
      // glyph halo, then hard-clip that halo at the midpoint to any nearby text
      // above/below that overlaps the same horizontal area. This removes the
      // whole selected line without ever reaching the next row.
      const baseTop=y, baseBottom=y+h;
      const extraY=Math.max(.65,Math.min(2.2,(fontSize||h||12)*.10));
      const extraX=Math.max(.35,Math.min(1.2,(fontSize||12)*.035));
      let top=baseTop-extraY, bottom=baseBottom+extraY;
      let nearestAboveCenter=-Infinity, nearestBelowCenter=Infinity;
      const minOverlap=Math.max(2,Math.min(12,w*.08));
      const currentCenter=(baseTop+baseBottom)/2;
      const pr=rec.shell.getBoundingClientRect();
      for(const other of rec.textLayer.children){
        if(other===span) continue;
        // Even a line that was already edited/deleted still acts as a boundary:
        // its original PDF position must keep the next line's mask isolated.
        const or=other.getBoundingClientRect();
        const ox=(or.left-pr.left)/zoom, oy=(or.top-pr.top)/zoom;
        const ow=Math.max(1,or.width/zoom), oh=Math.max(1,or.height/zoom);
        const overlap=Math.min(x+w,ox+ow)-Math.max(x,ox);
        if(overlap<minOverlap) continue;
        const oCenter=oy+oh/2;
        if(oCenter<currentCenter) nearestAboveCenter=Math.max(nearestAboveCenter,oCenter);
        else if(oCenter>currentCenter) nearestBelowCenter=Math.min(nearestBelowCenter,oCenter);
      }
      // Midpoints between line centres are hard boundaries. This still works
      // when PDF.js hit boxes themselves overlap vertically.
      if(Number.isFinite(nearestAboveCenter)){
        top=Math.max(top,(nearestAboveCenter+currentCenter)/2+.08);
      }
      if(Number.isFinite(nearestBelowCenter)){
        bottom=Math.min(bottom,(currentCenter+nearestBelowCenter)/2-.08);
      }
      top=Math.max(0,top);
      bottom=Math.min(rec.viewport.height,bottom);
      const left=Math.max(0,x-extraX), right=Math.min(rec.viewport.width,x+w+extraX);
      return {x:left,y:top,w:Math.max(2,right-left),h:Math.max(2,bottom-top)};
    }

    async function editExistingText(rec,span,pointerEvent){
      ensureEngine().catch(()=>{});
      const generation=documentGeneration,sourceFont=await loadSourcePdfFont(span.dataset.pdfFontName);
      if(sourceFont){span.dataset.renderFont=sourceFont.family;span.dataset.weight=sourceFont.weight;span.dataset.style=sourceFont.style;}
      await ensureEditorFont(span.dataset.renderFont||span.dataset.font);if(generation!==documentGeneration||!pageRecords.has(rec.pageNum)||span.style.pointerEvents==='none')return;
      const sr=span.getBoundingClientRect(), pr=rec.shell.getBoundingClientRect();
      const fontSize=parseFloat(span.dataset.size)||18;
      const x=parseFloat(span.style.left),y=parseFloat(span.style.top),w=Math.max(2,parseFloat(span.style.width));
      // Cap the source hit height to one font line so a nearby row can never be
      // treated as part of the text the user clicked.
      const h=Math.max(8,Math.min(parseFloat(span.style.height),fontSize*1.02));
      const backgroundInfo=analyzeTextBackground(rec,x,y,w,h);
      const sourceBackground=backgroundInfo.color;
      const sourceColor=detectTextColor(rec,x,y,w,h,sourceBackground);
      // Never shrink the erase region to only some detected glyph pixels: that
      // leaves visible letter fragments. Use the complete, neighbour-safe line
      // box instead.
      const sourceMaskRect={x,y,w,h};
      let pixelErase=null;
      if(span.dataset.rasterText==='true'||span.dataset.imageText==='true'){
        if(!backgroundInfo.flat){showToast('The image behind this text has a complex background. This selection cannot be changed safely.');return;}
        const r=isolatedSourceLineRect(rec,span,x,y,w,h,fontSize),inv=pdfjsLib.Util.inverseTransform(rec.viewport.transform),point=(px,py)=>[inv[0]*px+inv[2]*py+inv[4],inv[1]*px+inv[3]*py+inv[5]];
        pixelErase={quad:[...point(r.x,r.y),...point(r.x+r.w,r.y),...point(r.x,r.y+r.h),...point(r.x+r.w,r.y+r.h)],background:sourceBackground};
        prepareRasterTextPreview(rec,span,r,sourceBackground,sourceColor);
      }
      // Existing PDF text must never become underlined just because it was clicked.
      // Underline is now a manual user choice only.
      const sourceUnderline=false;
      const fontFamily=span.dataset.font||'Arial, sans-serif';
      const fontWeight=span.dataset.weight||'400';
      const fontStyle=span.dataset.style||'normal';
      // Keep the editable overlay at the exact hit-box coordinates. Do not
      // auto-nudge it up/down when editing starts: clicking text must never
      // visibly move the text before the user changes anything.
      const displayY=y;
      const obj={
        id:uid(),type:'text',x,y:displayY,w,h,text:span.textContent,originalText:span.textContent,deleted:false,
        sourceX:x,sourceY:y,sourceW:w,sourceH:h,sourceDisplayX:x,sourceDisplayY:displayY,
        sourceMaskX:sourceMaskRect.x,sourceMaskY:sourceMaskRect.y,sourceMaskW:sourceMaskRect.w,sourceMaskH:sourceMaskRect.h,
        sourcePdfPoint:JSON.parse(span.dataset.pdfPoint),sourceRedactQuad:JSON.parse(span.dataset.redactQuad),sourceItemIndex:+span.dataset.sourceIndex,sourceBaseline:JSON.parse(span.dataset.baseline),angle:+span.dataset.angle,
        fontSize,color:sourceColor,fontFamily,
        fontWeight,fontStyle,underline:false,cover:true,minCoverW:w,minCoverH:h,
        sourceFontSize:fontSize,
        sourceColor:sourceColor,
        sourceBackground:sourceBackground,
        sourceBackgroundFlat:!!backgroundInfo.flat,
        sourceBackgroundConfidence:backgroundInfo.confidence||0,
        sourceBackgroundDominance:backgroundInfo.dominance||0,
        sourceFontFamily:fontFamily,
        sourceRenderFont:span.dataset.renderFont||compatibleFont(fontFamily),
        pixelErase,
        sourceFontWeight:fontWeight,
        sourceFontStyle:fontStyle,
        sourceUnderline:false
      };
      span.style.pointerEvents='none'; span.style.outline='none';
      obj.sourceHitIndex=[...rec.textLayer.children].indexOf(span);
      addObject(rec,obj,true);
      selectObject(rec.pageNum,obj.id);
      startTextEditing(rec,obj,pointerEvent);
      showToast('Edit this text item. Other PDF content keeps its original position.');
    }

    function prepareRasterTextPreview(rec,span,rect,backgroundColor,textColor){
      if(!rec.instantRasterPreviewSafe||!rec.sourcePatches||Math.abs(+span.dataset.angle)>.001)return;
      const index=+span.dataset.sourceIndex;if(rec.sourcePatches.has(index))return;
      // Only use a quick crop when it cannot touch another text selection.
      if([...rec.textLayer.children].some(hit=>{
        if(hit===span)return false;
        const x=parseFloat(hit.style.left),y=parseFloat(hit.style.top),w=parseFloat(hit.style.width),h=parseFloat(hit.style.height);
        return rect.x<x+w&&rect.x+rect.w>x&&rect.y<y+h&&rect.y+rect.h>y;
      }))return;
      const sx=rec.canvas.width/rec.viewport.width,sy=rec.canvas.height/rec.viewport.height;
      const x=Math.max(0,Math.floor(rect.x*sx)),y=Math.max(0,Math.floor(rect.y*sy));
      const w=Math.min(rec.canvas.width,Math.ceil((rect.x+rect.w)*sx))-x,h=Math.min(rec.canvas.height,Math.ceil((rect.y+rect.h)*sy))-y;
      if(w<1||h<1)return;
      if([...rec.sourcePatches.values()].some(p=>x<p.x+p.original.width&&x+w>p.x&&y<p.y+p.original.height&&y+h>p.y))return;
      const original=document.createElement('canvas');original.width=w;original.height=h;original.getContext('2d').drawImage(rec.canvas,x,y,w,h,0,0,w,h);
      const background=document.createElement('canvas');background.width=w;background.height=h;
      const before=original.getContext('2d').getImageData(0,0,w,h).data.slice(),data=background.getContext('2d').createImageData(w,h);
      data.data.set(before);
      const bg=parseHexRgb(backgroundColor),fg=parseHexRgb(textColor),ink=new Uint8Array(w*h),rules=new Uint8Array(w*h);
      const axis=fg.map((v,k)=>v-bg[k]),length=axis.reduce((sum,v)=>sum+v*v,0)||1;
      let foreignPixels=0;
      for(let i=0;i<before.length;i+=4){
        const delta=bg.map((v,k)=>before[i+k]-v),t=delta.reduce((sum,v,k)=>sum+v*axis[k],0)/length;
        // JPEG glyph fringes can have a modest colour cast; stronger off-axis
        // colours identify a distinct graphic rather than compression noise.
        if(Math.hypot(...delta.map((v,k)=>v-t*axis[k]))>45)foreignPixels++;
      }
      // Use the verified engine for overlapping coloured graphics. Its image
      // edit leaves separate vector watermarks intact; a flat quick crop cannot.
      if(foreignPixels>Math.max(3,w*h*.015))return;
      const contrast=(px,py)=>Math.max(...bg.map((v,k)=>Math.abs(v-before[(py*w+px)*4+k])));
      for(let py=0;py<h;py++)for(let px=0;px<w;px++){
        const i=(py*w+px)*4,direction=bg.reduce((sum,v,k)=>sum+(before[i+k]-v)*(fg[k]-v),0);
        if(contrast(px,py)>30&&direction>0)ink[py*w+px]=1;
      }
      // Rules span nearly the entire crop; glyph strokes are shorter.
      for(let py=0;py<h;py++){let count=0;for(let px=0;px<w;px++)count+=ink[py*w+px];if(count>w*.85)for(let px=0;px<w;px++)rules[py*w+px]=1;}
      for(let px=0;px<w;px++){let count=0;for(let py=0;py<h;py++)count+=ink[py*w+px];if(count>h*.9)for(let py=0;py<h;py++)rules[py*w+px]=1;}
      for(let py=0;py<h;py++)for(let px=0;px<w;px++){
        if(rules[py*w+px]||contrast(px,py)<3)continue;
        let erase=false;
        for(let dy=-1;dy<=1&&!erase;dy++)for(let dx=-1;dx<=1&&!erase;dx++){
          const xx=px+dx,yy=py+dy;if(xx>=0&&xx<w&&yy>=0&&yy<h&&ink[yy*w+xx]&&!rules[yy*w+xx])erase=true;
        }
        if(erase){const i=(py*w+px)*4;for(let k=0;k<3;k++)data.data[i+k]=bg[k];}
      }
      background.getContext('2d').putImageData(data,0,0);
      const originalPixels=original.getContext('2d').createImageData(w,h);originalPixels.data.set(before);
      rec.sourcePatches.set(index,{x,y,original,background,originalPixels,backgroundPixels:data});
    }

    function addObject(rec,obj,recordHistory){
      rec.objects.push(obj);
      renderObject(rec,obj);
      syncLayerOrder(rec);
      if(recordHistory){
        commitHistory();
        updateUndoState();
      }
      refreshLayers(rec.pageNum);
    }

    function renderObject(rec,obj){
      let el=document.createElement('div');
      el.className='editor-object'; el.dataset.id=obj.id; el.dataset.page=rec.pageNum;
      if(obj.type==='text'){
        el.classList.add('obj-text');
        if(obj.cover)el.classList.add('pdf-source-edit');
        if(obj.isPlaceholder)el.classList.add('new-text-placeholder');
        el.textContent=obj.text;
        el.classList.toggle('pdf-source-edit',!!obj.cover);
        el.classList.toggle('pdf-source-deleted',!!(obj.cover&&obj.deleted));
        el.classList.toggle('new-text-placeholder',!!obj.isPlaceholder);
        if(!obj.cover) el.style.background=obj.isPlaceholder?'rgba(234,244,255,.96)':'transparent';
      }else if(obj.type==='image'){
        el.classList.add('obj-image');
        const img=document.createElement('img'); img.src=obj.src; img.alt=''; el.appendChild(img);
      }else if(obj.type==='shape'){
        el.classList.add('obj-shape');
      }else if(obj.type==='source-image'){
        el.classList.add('obj-source-image');
      }
      const handles={};
      if(obj.type==='image'||obj.type==='shape'){
        ['nw','ne','sw','se'].forEach(dir=>{
          const handle=document.createElement('div');
          handle.className='resize-handle';
          handle.dataset.dir=dir;
          el.appendChild(handle);
          handles[dir]=handle;
        });
      }
      rec.objectLayer.appendChild(el);
      let moveHandle=null;
      if(obj.type==='text'){
        moveHandle=document.createElement('button');
        moveHandle.type='button';
        moveHandle.className='text-move-handle';
        moveHandle.dataset.for=obj.id;
        moveHandle.title='Move text';
        moveHandle.setAttribute('aria-label','Move text');
        rec.objectLayer.appendChild(moveHandle);
      }
      applyObjectStyle(rec,obj,el);
      setupObjectInteraction(rec,obj,el,handles);
      if(moveHandle)setupTextMoveHandle(rec,obj,moveHandle);
      syncLayerOrder(rec);
      return el;
    }

    // Cache small, exact background crops before the page becomes interactive.
    // The text-free render retains PDF graphics, images and table rules. Crops
    // are used only for isolated, horizontal text; other cases use the verified
    // removal engine. These canvases are preview assets, never export content.
    async function prepareInstantTextPreview(rec){
      rec.sourcePatches=new Map();rec.visibleRemovedSources=new Set();
      rec.instantRasterPreviewSafe=false;
      rec.sourceCheckPatches=new Map();
      const pixels=rec.canvas.getContext('2d'),sxCheck=rec.canvas.width/rec.viewport.width,syCheck=rec.canvas.height/rec.viewport.height;
      for(const hit of rec.textLayer.children){
        const quad=JSON.parse(hit.dataset.redactQuad||'null');if(!quad)continue;
        const margin=Math.max(2,(+hit.dataset.size||12)*.45),xs=[quad[0],quad[2],quad[4],quad[6]],ys=[quad[1],quad[3],quad[5],quad[7]];
        const x=Math.max(0,Math.floor((Math.min(...xs)-margin)*sxCheck)),y=Math.max(0,Math.floor((Math.min(...ys)-margin)*syCheck));
        const w=Math.min(rec.canvas.width,Math.ceil((Math.max(...xs)+margin)*sxCheck))-x,h=Math.min(rec.canvas.height,Math.ceil((Math.max(...ys)+margin)*syCheck))-y;
        if(w>0&&h>0)rec.sourceCheckPatches.set(+hit.dataset.sourceIndex,{x,y,w,h,data:pixels.getImageData(x,y,w,h).data});
      }
      const ops=await rec.page.getOperatorList(),OPS=pdfjsLib.OPS;
      // Text clipping can affect subsequent graphics: never shortcut that case.
      if(ops.fnArray.some((fn,i)=>fn===OPS.setTextRenderingMode && ops.argsArray[i][0]>=4))return;
      rec.instantRasterPreviewSafe=true;
      const hits=[...rec.textLayer.children],sx=rec.canvas.width/rec.viewport.width,sy=rec.canvas.height/rec.viewport.height;
      const boxes=hits.map(hit=>({hit,x:parseFloat(hit.style.left),y:parseFloat(hit.style.top),w:parseFloat(hit.style.width),h:parseFloat(hit.style.height),angle:+hit.dataset.angle,margin:Math.max(2,parseFloat(hit.dataset.size||hit.style.height)*.2)}));
      const candidates=boxes.filter(b=>Math.abs(b.angle)<.001 && !boxes.some(other=>other!==b && b.x-b.margin<other.x+other.w+other.margin && b.x+b.w+b.margin>other.x-other.margin && b.y-b.margin<other.y+other.h+other.margin && b.y+b.h+b.margin>other.y-other.margin));
      if(!candidates.length&&!rec.imageHitLayer?.children.length)return;
      const backdrop=document.createElement('canvas');backdrop.width=rec.canvas.width;backdrop.height=rec.canvas.height;
      const textOps=new Set([OPS.showText,OPS.showSpacedText,OPS.nextLineShowText,OPS.nextLineSetSpacingShowText]);
      try{
        await rec.page.render({canvasContext:backdrop.getContext('2d',{alpha:false}),viewport:rec.viewport,transform:[rec.renderDpr,0,0,rec.renderDpr,0,0],operationsFilter:index=>!textOps.has(ops.fnArray[index])}).promise;
        for(const b of boxes){
          if(Math.abs(b.angle)>.001)continue;
          const covered=[...(rec.imageHitLayer?.children||[])].some(hit=>Math.max(0,Math.min(b.x+b.w,+hit.dataset.x + +hit.dataset.w)-Math.max(b.x,+hit.dataset.x))*Math.max(0,Math.min(b.y+b.h,+hit.dataset.y + +hit.dataset.h)-Math.max(b.y,+hit.dataset.y))>b.w*b.h*.3);
          if(!covered)continue;
          const info=analyzeTextBackground(rec,b.x,b.y,b.w,b.h);if(!info.flat)continue;
          const x=Math.max(0,Math.floor(b.x*sx)),y=Math.max(0,Math.floor(b.y*sy)),w=Math.min(rec.canvas.width-x,Math.ceil(b.w*sx)),h=Math.min(rec.canvas.height-y,Math.ceil(b.h*sy));if(w<1||h<1)continue;
          const before=rec.canvas.getContext('2d').getImageData(x,y,w,h).data,after=backdrop.getContext('2d').getImageData(x,y,w,h).data,bg=parseHexRgb(info.color);let ink=0,remaining=0;
          const rows=new Uint32Array(h),cols=new Uint32Array(w);
          for(let i=0;i<after.length;i+=4)if(Math.max(...bg.map((v,k)=>Math.abs(v-after[i+k])))>30){rows[Math.floor(i/4/w)]++;cols[(i/4)%w]++;}
          for(let i=0;i<before.length;i+=4){if(rows[Math.floor(i/4/w)]>w*.85||cols[(i/4)%w]>h*.85||Math.max(...bg.map((v,k)=>Math.abs(v-before[i+k])))<40)continue;ink++;if(Math.max(...bg.map((v,k)=>Math.abs(v-after[i+k])))>30&&Math.max(...bg.map((v,k)=>Math.abs(before[i+k]-after[i+k])))<25)remaining++;}
          if(ink>3&&remaining>ink*.45)b.hit.dataset.rasterText='true';
        }
        for(const b of candidates){
          const x=Math.max(0,Math.floor((b.x-b.margin)*sx)),y=Math.max(0,Math.floor((b.y-b.margin)*sy));
          const w=Math.min(rec.canvas.width,Math.ceil((b.x+b.w+b.margin)*sx))-x,h=Math.min(rec.canvas.height,Math.ceil((b.y+b.h+b.margin)*sy))-y;
          if(w<1||h<1)continue;
          const crop=canvas=>{const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(canvas,x,y,w,h,0,0,w,h);return c;};
          const original=crop(rec.canvas),background=crop(backdrop);
          const before=original.getContext('2d').getImageData(0,0,w,h).data,after=background.getContext('2d').getImageData(0,0,w,h).data;
          if(b.hit.dataset.rasterText==='true'||!before.some((v,i)=>Math.abs(v-after[i])>3)){b.hit.dataset.imageText='true';continue;}
          rec.sourcePatches.set(+b.hit.dataset.sourceIndex,{x,y,original,background});
        }
      }catch(_){rec.sourcePatches.clear();}
      finally{backdrop.width=backdrop.height=1;}
    }

    function applyInstantTextPreview(rec){
      if(!rec.sourcePatches?.size)return;
      const ctx=rec.canvas.getContext('2d');
      const removedImages=rec.objects.filter(o=>o.type==='source-image'&&o.deleted);
      const sx=rec.canvas.width/rec.viewport.width,sy=rec.canvas.height/rec.viewport.height;
      const overlapsRemovedImage=patch=>removedImages.some(o=>patch.x<(o.x+o.w)*sx&&patch.x+patch.background.width>o.x*sx&&patch.y<(o.y+o.h)*sy&&patch.y+patch.background.height>o.y*sy);
      // Include absent objects so Undo of the first edit restores the original.
      for(const index of rec.visibleRemovedSources||[]){
        if(rec.objects.some(o=>o.cover&&o.sourceItemIndex===index&&sourceTextNeedsReplacement(o)))continue;
        const patch=rec.sourcePatches.get(index);
        if(patch&&!overlapsRemovedImage(patch)){if(patch.originalPixels)ctx.putImageData(patch.originalPixels,patch.x,patch.y);else ctx.drawImage(patch.original,patch.x,patch.y);rec.visibleRemovedSources.delete(index);}
      }
      // Image removals can overlap text crops. Preserve the engine result there.
      for(const obj of rec.objects){
        if(!obj.cover||!sourceTextNeedsReplacement(obj)||rec.visibleRemovedSources.has(obj.sourceItemIndex))continue;
        const patch=rec.sourcePatches.get(obj.sourceItemIndex);if(!patch)continue;
        if(overlapsRemovedImage(patch))continue;
        if(patch.backgroundPixels)ctx.putImageData(patch.backgroundPixels,patch.x,patch.y);else ctx.drawImage(patch.background,patch.x,patch.y);rec.visibleRemovedSources.add(obj.sourceItemIndex);
      }
    }

    function syncSourceTextVisibility(rec){
      for(const obj of rec.objects){
        if(obj.type!=='text' || !obj.cover)continue;
        const el=rec.objectLayer.querySelector(`[data-id="${obj.id}"]`);
        if(el){
          const active=sourceTextNeedsReplacement(obj);
          el.style.color=(active && !obj.deleted && rec.visibleRemovedSources?.has(obj.sourceItemIndex))?obj.color:'transparent';
          el.style.background='transparent';
          el.style.caretColor=obj.color||'#000000';
        }
      }
    }

    function requestSourceTextPreview(rec){
      if(!rec)return;
      applyInstantTextPreview(rec);
      syncSourceTextVisibility(rec);
      if(rec.isBlank||!rec.hydrated)return;
      const job=jobForPage(rec),signature=JSON.stringify(job);
      if(rec.previewSignature===signature)return;
      clearTimeout(rec.previewTimer);
      const generation=documentGeneration;
      rec.previewTimer=setTimeout(()=>{
        rec.previewQueue=(rec.previewQueue||Promise.resolve()).catch(()=>{}).then(()=>{
          if(generation!==documentGeneration||!pageRecords.has(rec.pageNum)||rec.previewSignature===signature||JSON.stringify(jobForPage(rec))!==signature)return;
          return renderRemovalPreview(rec,job,signature);
        });
      },0);
    }
    async function renderRemovalPreview(rec,job,signature){
      const generation=documentGeneration;rec.previewRunning=true;
      let task=null,canvas=null;
      try{
        let doc;
        if(job.items.length||job.images.length){
          if(job.items.some(item=>item.pixelErase))await cacheRasterImages(rec);
          const response=await engineRequest('remove',{jobs:[job],onlyPage:rec.originalPageNum});
          if(generation!==documentGeneration||JSON.stringify(jobForPage(rec))!==signature)return;
          task=pdfjsLib.getDocument(pdfOptions(response.bytes));doc=await task.promise;
        }
        const page=doc?await doc.getPage(1):rec.page;
        canvas=document.createElement('canvas');canvas.width=rec.canvas.width;canvas.height=rec.canvas.height;
        const render=page.render({canvasContext:canvas.getContext('2d',{alpha:false}),viewport:page.getViewport({scale:rec.viewport.scale}),transform:[rec.renderDpr,0,0,rec.renderDpr,0,0]});
        await render.promise;
        if(generation!==documentGeneration||JSON.stringify(jobForPage(rec))!==signature)return;
        verifyVisibleTextRemoval(rec,canvas,job);
        rec.canvas.getContext('2d').drawImage(canvas,0,0);
        rec.visibleRemovedSources=new Set(rec.objects.filter(sourceTextNeedsReplacement).map(o=>o.sourceItemIndex));
        syncSourceTextVisibility(rec);
        rec.previewSignature=signature;rec.previewError=null;rec.safeSourceObjects=rec.objects.filter(o=>o.cover||o.type==='source-image').map(deep);
        const thumb=document.createElement('canvas');thumb.width=100;thumb.height=Math.round(100*rec.viewport.height/rec.viewport.width);thumb.getContext('2d').drawImage(rec.canvas,0,0,thumb.width,thumb.height);rec.thumbnail=thumb.toDataURL();updateThumbnailImage(rec);
      }catch(e){
        if(generation===documentGeneration&&JSON.stringify(jobForPage(rec))===signature){rec.previewError=e;showError(e,'This PDF selection cannot be changed safely');rollbackUnsafeRemoval(rec);}
      }finally{
        if(task)await task.destroy().catch(()=>{});
        if(canvas)canvas.width=canvas.height=1;
        rec.previewRunning=false;
      }
    }
    function verifyVisibleTextRemoval(rec,canvas,job){
      const ctx=canvas.getContext('2d');
      for(const item of job.items){
        const patch=rec.sourceCheckPatches?.get(item.sourceItemIndex);if(!patch)continue;
        const after=ctx.getImageData(patch.x,patch.y,patch.w,patch.h).data;
        if(!patch.data.some((v,i)=>Math.abs(v-after[i])>3))throw new Error('The visible letters were not removed. This may be image-based text. Your original text has been kept.');
      }
    }
    async function verifyPendingSourceChanges(){
      for(const key of pageOrder){
        const rec=pageRecords.get(key);if(!rec||rec.isBlank)continue;
        let job=jobForPage(rec);if(!job.items.length&&!job.images.length)continue;
        const expectedSignature=JSON.stringify(job);
        await hydratePage(rec);if(!rec.hydrated)throw new Error('The edited page could not be checked. Please try again.');
        clearTimeout(rec.previewTimer);await rec.previewQueue;
        job=jobForPage(rec);const signature=JSON.stringify(job);
        if(rec.previewError||signature!==expectedSignature)throw new Error('The last text or image removal could not be verified. Please review the page before downloading.');
        if(rec.previewSignature!==signature)await renderRemovalPreview(rec,job,signature);
        if(rec.previewError||rec.previewSignature!==signature)throw new Error('The last text or image removal could not be verified. Please review the page before downloading.');
      }
    }
    function rollbackUnsafeRemoval(rec){
      finishTextEditing();
      for(const obj of rec.objects){
        if(obj.type==='text'&&obj.cover&&sourceTextNeedsReplacement(obj)){
          const safe=rec.safeSourceObjects?.find(o=>o.id===obj.id);
          delete obj.replacementPositioned;delete obj.textScaleX;
          if(safe)Object.assign(obj,deep(safe));else Object.assign(obj,{text:obj.originalText,deleted:false,x:obj.sourceDisplayX,y:obj.sourceDisplayY,fontSize:obj.sourceFontSize,fontFamily:obj.sourceFontFamily,fontWeight:obj.sourceFontWeight,fontStyle:obj.sourceFontStyle,color:obj.sourceColor,underline:false});
          const el=rec.objectLayer.querySelector(`[data-id="${obj.id}"]`);if(el)el.textContent=obj.text;applyObjectStyle(rec,obj);
        }else if(obj.type==='source-image'){obj.deleted=rec.safeSourceObjects?.find(o=>o.id===obj.id)?.deleted||false;applyObjectStyle(rec,obj);}
      }
      rec.previewSignature=null;history=[];redoHistory=[];committedState=captureState();updateUndoState();requestSourceTextPreview(rec);refreshLayers();
    }


    function applyObjectStyle(rec,obj,el=null){
      el = el || rec.objectLayer.querySelector(`[data-id="${obj.id}"]`); if(!el)return;
      if(obj.type==='text'&&!obj.deleted&&(!obj.cover||sourceTextNeedsReplacement(obj))){
        obj.fontFamily=obj.cover&&obj.fontFamily===obj.sourceFontFamily?(obj.sourceRenderFont||compatibleFont(obj.fontFamily)):compatibleFont(obj.fontFamily);
        const originalFont=sourcePdfFonts.get(obj.fontFamily);
        if(originalFont&&[...String(obj.text)].some(c=>c!=='\n'&&!originalFont.supported.has(c.codePointAt(0)))){obj.fontFamily=originalFont.fallback;delete obj.textScaleX;}
        if(!sourcePdfFonts.has(obj.fontFamily)&&/[^\u0000-\u024f\u2000-\u206f]/.test(obj.text||''))obj.fontFamily='RiloUnicode';
        if(obj.cover&&!obj.replacementPositioned&&obj.sourceBaseline){
          const offset=textBaselineOffset(obj),angle=obj.angle||0;
          if(nearEqual(obj.x,obj.sourceDisplayX)&&nearEqual(obj.y,obj.sourceDisplayY)){
            obj.x=obj.sourceBaseline[0]+Math.sin(angle)*offset;obj.y=obj.sourceBaseline[1]-Math.cos(angle)*offset;
          }
          obj.replacementPositioned=true;
        }
        if(obj.cover&&obj.textScaleX==null){
          const ctx=document.createElement('canvas').getContext('2d');
          ctx.font=`${obj.sourceFontStyle||'normal'} ${obj.sourceFontWeight||400} ${obj.sourceFontSize}px ${obj.fontFamily}`;
          const width=ctx.measureText(obj.originalText||'').width;
          obj.textScaleX=width>0?clamp(obj.sourceW/width,.15,6):1;
        }
      }
      const textScale=obj.type==='text'?(obj.textScaleX||1):1;
      el.style.transform=(obj.angle?`rotate(${obj.angle}rad) `:'')+(textScale!==1?`scaleX(${textScale})`:'');el.style.transformOrigin='left top';
      el.style.left=obj.x+'px'; el.style.top=obj.y+'px'; el.style.width=Math.max(obj.type==='text'?2:6,obj.w/textScale)+'px'; el.style.height=Math.max(obj.type==='text'?2:6,obj.h)+'px';
      if(obj.type==='text'){
        // For untouched source PDF text, show the ORIGINAL canvas glyphs rather
        // than a browser-font copy. This makes selecting/clicking text visually
        // lossless: no baseline jump, no spacing collapse and no colour change.
        const pristinePdfText=!!(obj.cover && !obj.deleted && !sourceTextNeedsReplacement(obj));
        if(!pristinePdfText && !obj.deleted){obj.fontFamily=compatibleFont(obj.fontFamily);}
        el.style.fontFamily=obj.fontFamily; el.style.fontSize=obj.fontSize+'px';
        el.style.color=obj.deleted?'transparent':(pristinePdfText?'transparent':(obj.isPlaceholder?'#64748b':obj.color));
        el.style.fontWeight=obj.fontWeight; el.style.fontStyle=obj.fontStyle||'normal';
        el.style.textDecorationLine=pristinePdfText?'none':(obj.underline?'underline':'none');
        el.style.textDecorationColor=obj.color||'#000000'; el.style.textDecorationThickness=obj.underline?'0.065em':'auto'; el.style.textUnderlineOffset=obj.underline?'0.08em':'auto';
        el.classList.toggle('new-text-placeholder',!!obj.isPlaceholder);
        if(!obj.cover) el.style.background=obj.isPlaceholder?'rgba(234,244,255,.96)':'transparent';
        else el.style.background='transparent';
        el.classList.toggle('pdf-source-deleted',!!(obj.cover&&obj.deleted));
        if(obj.cover)requestSourceTextPreview(rec);
      } else if(obj.type==='shape'){
        el.style.background=obj.fill||'transparent'; el.style.border=`${obj.borderWidth||0}px solid ${obj.border||'transparent'}`;
        el.style.borderRadius=obj.kind==='circle'?'50%':'0';
      } else if(obj.type==='source-image'){
        el.style.background='transparent';
        syncSourceImageHits(rec);
        requestSourceTextPreview(rec);
        el.style.border='0';
      }
      if(obj.type==='text')updateTextMoveHandle(rec,obj);
      updateThumbnailImage(rec);
    }

    function updateTextMoveHandle(rec,obj){
      const mh=rec.objectLayer.querySelector(`.text-move-handle[data-for="${obj.id}"]`);
      if(!mh)return;
      const hw=26;
      if(obj.angle&&!obj.cover){
        const offset=rotateVector(-10,obj.y>=30?-29:Math.max(20,obj.h)+3,obj.angle);
        mh.style.left=clamp(obj.x+offset.x,0,Math.max(0,rec.viewport.width-hw))+'px';
        mh.style.top=clamp(obj.y+offset.y,0,Math.max(0,rec.viewport.height-hw))+'px';
        mh.style.transform=`rotate(${obj.angle}rad)`;mh.style.transformOrigin='left top';
        mh.classList.toggle('show',!!selected&&selected.pageNum===rec.pageNum&&selected.id===obj.id&&!obj.deleted);return;
      }
      // Keep the movement control at the upper-left of the selected text.
      // If there is no room above the text, place it just below while keeping it on-page.
      const left=clamp(obj.x-10,0,Math.max(0,rec.viewport.width-hw));
      const top=obj.y>=30?obj.y-29:Math.min(rec.viewport.height-hw,obj.y+Math.max(20,obj.h)+3);
      mh.style.left=left+'px';
      mh.style.top=clamp(top,0,Math.max(0,rec.viewport.height-hw))+'px';
      mh.classList.toggle('show',!!selected&&selected.pageNum===rec.pageNum&&selected.id===obj.id&&!obj.deleted);
    }

    function setupTextMoveHandle(rec,obj,moveHandle){
      moveHandle.addEventListener('pointerdown',e=>{
        if(exportInProgress)return;
        e.stopPropagation();e.preventDefault();
        const el=rec.objectLayer.querySelector(`[data-id="${obj.id}"]`);
        if(el&&el.isContentEditable)el.blur();
        currentPage=rec.pageNum;selectObject(rec.pageNum,obj.id);
        const before=deep(obj),start=pagePoint(rec,e),ox=obj.x,oy=obj.y,pid=e.pointerId;
        moveHandle.setPointerCapture(pid);
        const move=ev=>{
          const p=pagePoint(rec,ev);
          const offsets=objectOffsets(obj);
          obj.x=clamp(ox+p.x-start.x,-offsets.minX,Math.max(-offsets.minX,rec.viewport.width-offsets.maxX));
          obj.y=clamp(oy+p.y-start.y,-offsets.minY,Math.max(-offsets.minY,rec.viewport.height-offsets.maxY));
          applyObjectStyle(rec,obj,el);
        };
        const up=()=>{
          moveHandle.removeEventListener('pointermove',move);moveHandle.removeEventListener('pointerup',up);moveHandle.removeEventListener('pointercancel',up);
          try{moveHandle.releasePointerCapture(pid)}catch(_){}
          pushUpdateUndo(rec,obj,before);selectObject(rec.pageNum,obj.id);
        };
        moveHandle.addEventListener('pointermove',move);moveHandle.addEventListener('pointerup',up);moveHandle.addEventListener('pointercancel',up);
      });
    }

    function partialBounds(rec,obj){
      // Keep only a small grab area visible; the rest may sit outside the PDF page.
      // The PDF page itself clips anything outside its page box when exported.
      const keep=Math.min(12,Math.max(4,Math.min(obj.w||12,obj.h||12)/3));
      const offsets=objectOffsets(obj);
      return {
        minX:-offsets.maxX+keep,
        maxX:rec.viewport.width-offsets.minX-keep,
        minY:-offsets.maxY+keep,
        maxY:rec.viewport.height-offsets.minY-keep
      };
    }

    function setupObjectInteraction(rec,obj,el,handles){
      el.addEventListener('pointerdown', e => {
        if(exportInProgress)return;
        if(activeTool==='shape'&&shapeDrawArmed){e.stopPropagation();e.preventDefault();beginDraw(rec,e,defaultShapeKind);return;}
        e.stopPropagation(); currentPage=rec.pageNum; selectObject(rec.pageNum,obj.id);
        if(obj.type==='shape' && activeTool==='shape') setActiveTool('select');
        if(obj.type==='text' && activeTool==='text'){
          if(obj.cover&&obj.deleted){showToast('This text is deleted. Use Restore text first.');return;}
          if(!el.isContentEditable)startTextEditing(rec,obj,e);
          return;
        }
        if(obj.type==='text' && el.isContentEditable) return;
        if(obj.type==='source-image')return;
        if(e.target.closest('.resize-handle'))return;
        const before=deep(obj); const start=pagePoint(rec,e), ox=obj.x,oy=obj.y; const pid=e.pointerId; el.setPointerCapture(pid);
        const move=ev=>{const p=pagePoint(rec,ev);const b=partialBounds(rec,obj);obj.x=clamp(ox+p.x-start.x,b.minX,b.maxX);obj.y=clamp(oy+p.y-start.y,b.minY,b.maxY);applyObjectStyle(rec,obj,el)};
        const up=()=>{el.removeEventListener('pointermove',move);el.removeEventListener('pointerup',up);el.removeEventListener('pointercancel',up);try{el.releasePointerCapture(pid)}catch(_){};pushUpdateUndo(rec,obj,before)};
        el.addEventListener('pointermove',move);el.addEventListener('pointerup',up);el.addEventListener('pointercancel',up);
      });
      Object.entries(handles||{}).forEach(([dir,handle])=>handle.addEventListener('pointerdown', e=>{
        e.stopPropagation(); e.preventDefault(); const before=deep(obj), start=pagePoint(rec,e), ox=obj.x,oy=obj.y,ow=obj.w,oh=obj.h; const pid=e.pointerId; handle.setPointerCapture(pid);
        const move=ev=>{
          const p=pagePoint(rec,ev),delta=rotateVector(p.x-start.x,p.y-start.y,-(obj.angle||0)); const dx=delta.x,dy=delta.y;
          let nx=ox, ny=oy, nw=ow, nh=oh;
          const maxW=Math.max(8,rec.viewport.width*2.5);
          const maxH=Math.max(8,rec.viewport.height*2.5);
          if(dir.includes('e')) nw=clamp(ow+dx,8,maxW);
          if(dir.includes('s')) nh=clamp(oh+dy,8,maxH);
          if(dir.includes('w')){ nx=ox+dx; nw=ow-dx; if(nw<8){nx=ox+ow-8;nw=8;} if(nw>maxW){nx=ox+ow-maxW;nw=maxW;} }
          if(dir.includes('n')){ ny=oy+dy; nh=oh-dy; if(nh<8){ny=oy+oh-8;nh=8;} if(nh>maxH){ny=oy+oh-maxH;nh=maxH;} }
          const shift=rotateVector(nx-ox,ny-oy,obj.angle||0);
          obj.x=ox+shift.x;obj.y=oy+shift.y;obj.w=nw;obj.h=nh;applyObjectStyle(rec,obj,el);
        };
        const up=()=>{Object.values(handles||{}).forEach(h=>{h.removeEventListener('pointermove',move);h.removeEventListener('pointerup',up);h.removeEventListener('pointercancel',up)});try{handle.releasePointerCapture(pid)}catch(_){};pushUpdateUndo(rec,obj,before)};
        handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',up);handle.addEventListener('pointercancel',up);
      }));
      if(obj.type==='text'){
        el.addEventListener('paste',e=>{e.preventDefault();insertPlainTextAtCaret(e.clipboardData.getData('text/plain'));el.dispatchEvent(new Event('input',{bubbles:true}));});
        el.addEventListener('dblclick', e=>{e.stopPropagation();if(obj.cover&&obj.deleted){showToast('Restore this text before editing it.');return;}startTextEditing(rec,obj,e)});
        el.addEventListener('input',()=>{
          if(obj.isPlaceholder){
            obj.isPlaceholder=false;
            el.classList.remove('new-text-placeholder');
          }
          obj.text=el.innerText.replace(/\r/g,'');
          applyObjectStyle(rec,obj,el);
          autoSizeText(rec,obj,el);
        });
        el.addEventListener('keydown',e=>{
          if(e.key==='Enter' && e.shiftKey){
            e.preventDefault();insertPlainTextAtCaret('\n');
            obj.text=el.innerText.replace(/\r/g,'');autoSizeText(rec,obj,el);applyObjectStyle(rec,obj,el);return;
          }
          if(e.key==='Enter' && !e.shiftKey){e.preventDefault();el.blur();return;}
          e.stopPropagation();
        });
        el.addEventListener('blur',()=>{
          if(el.isContentEditable){
            el.contentEditable='false';
            obj.text=el.innerText.replace(/\r/g,'');
            if(!obj.text && !obj.cover){
              const idx=rec.objects.findIndex(o=>o.id===obj.id);if(idx>=0)rec.objects.splice(idx,1);el.remove();const mh=rec.objectLayer.querySelector(`.text-move-handle[data-for="${obj.id}"]`);if(mh)mh.remove();clearSelection();refreshLayers(rec.pageNum);commitHistory();return;
            }
            applyObjectStyle(rec,obj,el);
            // If the user only clicked an existing PDF text and left it unchanged,
            // keep its original hit box too. No browser-font measurement should
            // alter an untouched source object.
            if(!(obj.cover && !sourceTextNeedsReplacement(obj))) autoSizeText(rec,obj,el);
            const prev=el.dataset.beforeText;
            if(prev!=null&&prev!==obj.text){const old=prev;commitHistory();updateUndoState();}
            delete el.dataset.beforeText;
            refreshLayers(rec.pageNum);
          }
        });
      }
    }

    function pushUpdateUndo(rec,obj,before){
      const after=JSON.stringify(obj); if(after===JSON.stringify(before)) return;
      commitHistory(); updateUndoState();
    }

    function insertPlainTextAtCaret(text){
      const sel=window.getSelection();if(!sel||!sel.rangeCount)return;
      const range=sel.getRangeAt(0);range.deleteContents();const node=document.createTextNode(text);range.insertNode(node);range.setStartAfter(node);range.collapse(true);sel.removeAllRanges();sel.addRange(range);
    }

    function autoSizeText(rec,obj,el){
      // Fit the selection box to the actual visible text. The original PDF
      // source/redaction box is stored separately, so this box can safely
      // grow or shrink without weakening permanent text removal.
      const raw=(el.innerText!=null?el.innerText:String(obj.text||'')).replace(/\r/g,'');
      const lines=raw.split('\n');
      const measure=document.createElement('canvas').getContext('2d');
      const fam=obj.fontFamily||'Arial, sans-serif';
      measure.font=`${obj.fontStyle||'normal'} ${obj.fontWeight||'400'} ${obj.fontSize}px ${fam}`;
      let naturalW=8;
      for(const line of lines){
        naturalW=Math.max(naturalW,measure.measureText(line||' ').width+12);
      }
      const lineHeight=Math.max(8,obj.fontSize*1.16);
      // Source rows can be closer than a browser line box plus padding.
      // Keep their selection compact so the next PDF row stays clickable.
      const extraHeight=obj.cover?0:6;
      const naturalH=Math.max(1,lines.length)*lineHeight+extraHeight;

      // Do not stop the box at the page edge: if text gets larger near an
      // edge, the box should still surround it. The PDF page clips overflow.
      obj.w=Math.max(obj.isPlaceholder?170:8,Math.min(10000,naturalW*(obj.textScaleX||1)));
      obj.h=Math.max(8,Math.min(10000,naturalH));
      el.style.width=(obj.w/(obj.textScaleX||1))+'px';
      el.style.height=obj.h+'px';
      updateTextMoveHandle(rec,obj);
    }

    function placeCaret(el,pointerEvent){
      const sel=window.getSelection();if(!sel)return;
      let range=null;
      if(pointerEvent && document.caretRangeFromPoint){
        const r=document.caretRangeFromPoint(pointerEvent.clientX,pointerEvent.clientY);
        if(r && el.contains(r.startContainer))range=r;
      }else if(pointerEvent && document.caretPositionFromPoint){
        const p=document.caretPositionFromPoint(pointerEvent.clientX,pointerEvent.clientY);
        if(p && el.contains(p.offsetNode)){range=document.createRange();range.setStart(p.offsetNode,p.offset);range.collapse(true)}
      }
      if(!range){range=document.createRange();range.selectNodeContents(el);range.collapse(false)}
      sel.removeAllRanges();sel.addRange(range);
    }

    function selectAllText(el){
      const sel=window.getSelection();if(!sel)return;
      const range=document.createRange();range.selectNodeContents(el);sel.removeAllRanges();sel.addRange(range);
    }

    function startTextEditing(rec,obj,pointerEvent=null){
      ensureEditorFont(obj.fontFamily).catch(()=>{});
      if(obj&&obj.cover&&obj.deleted){showToast('Restore this text before editing it.');return;}
      const el=rec.objectLayer.querySelector(`[data-id="${obj.id}"]`); if(!el)return;
      el.dataset.beforeText=obj.text; el.contentEditable='true'; el.focus();
      // IMPORTANT: when existing PDF text is only selected, keep the original
      // canvas text visually untouched. Re-rendering it with a browser font can
      // shift the baseline/spacing even before the user makes a change.
      // New text (or an already modified PDF text object) can still auto-fit.
      const pristinePdfText=!!(obj.cover && !sourceTextNeedsReplacement(obj));
      if(!pristinePdfText) autoSizeText(rec,obj,el);
      requestAnimationFrame(()=>{if(obj.isPlaceholder)selectAllText(el);else placeCaret(el,pointerEvent)});
    }

    function selectObject(pageNum,id){
      $$('.editor-object.selected').forEach(x=>x.classList.remove('selected'));
      $$('.text-move-handle.show').forEach(x=>x.classList.remove('show'));
      selected={pageNum,id}; currentPage=pageNum;
      const rec=pageRecords.get(pageNum), obj=rec.objects.find(o=>o.id===id), el=rec.objectLayer.querySelector(`[data-id="${id}"]`);
      if(el)el.classList.add('selected');
      if(obj&&obj.type==='text')updateTextMoveHandle(rec,obj);
      updateProperties(obj);
      refreshLayers(pageNum);
    }
    function clearSelection(){selected=null;$$('.editor-object.selected').forEach(x=>x.classList.remove('selected'));$$('.text-move-handle.show').forEach(x=>x.classList.remove('show'));palette.classList.remove('show');updateProperties(null);refreshLayers()}
    function getSelected(){if(!selected)return null;const rec=pageRecords.get(selected.pageNum);if(!rec)return null;const obj=rec.objects.find(o=>o.id===selected.id);return obj?{rec,obj}:null}

    function updateProperties(obj){
      const showForImageMode=!obj && activeTool==='image';
      const showForNewText=!obj && activeTool==='addtext';
      if(!obj && !showForImageMode && !showForNewText){propertybar.classList.remove('show');return}
      propertybar.classList.add('show');
      textProps.classList.toggle('hidden',!((obj&&obj.type==='text')||showForNewText));
      imageProps.classList.toggle('hidden',!(showForImageMode || (obj && (obj.type==='image'||obj.type==='source-image'))));
      shapeProps.classList.toggle('hidden',!obj||obj.type!=='shape');
      $('#deleteBtn').classList.toggle('hidden',!obj);
      $('#copyTextBtn').classList.toggle('hidden',!obj||obj.type!=='text'||!!obj.deleted);
      if(!obj){
        if(showForNewText){
          $('#fontFamilySelect').disabled=false;
          const stale=$('#fontFamilySelect').querySelector('option[data-current-font]');if(stale)stale.remove();
          $('#fontFamilySelect').value=textDefaults.fontFamily;
          $('#fontSizeInput').value=Math.round(textDefaults.fontSize);
          $('#textColorInput').value=normalizeHex(textDefaults.color,'#000000');
          $('#boldBtn').classList.toggle('active',!!textDefaults.bold);
          $('#underlineBtn').classList.toggle('active',!!textDefaults.underline);
          $('#fontReadout').textContent='';
        }
        return;
      }
      if(obj.type==='text'){
        $('#fontSizeInput').value=Math.round(obj.fontSize);
        $('#textColorInput').value=normalizeHex(obj.color,'#000000');
        $('#boldBtn').classList.toggle('active',String(obj.fontWeight)==='700'||String(obj.fontWeight)==='bold');
        $('#underlineBtn').classList.toggle('active',!!obj.underline);
        if(obj.cover){
          const fontSelect=$('#fontFamilySelect');
          fontSelect.disabled=!!obj.deleted;
          const currentOpt=fontSelect.querySelector('option[data-current-font]');
          if(currentOpt)currentOpt.remove();
          const values=[...fontSelect.options].map(o=>o.value);
          if(values.includes(obj.fontFamily)){
            fontSelect.value=obj.fontFamily;
          }else{
            const opt=document.createElement('option');
            opt.value=obj.fontFamily;
            opt.dataset.currentFont='1';
            opt.textContent='Current: '+cleanFontName(obj.fontFamily);
            fontSelect.insertBefore(opt,fontSelect.firstChild);
            fontSelect.value=obj.fontFamily;
          }
          $('#fontReadout').textContent='';
          $('#deleteBtn').textContent=obj.deleted?'Restore text':'Delete existing text';
        }else{
          $('#fontFamilySelect').disabled=false;
          const stale=$('#fontFamilySelect').querySelector('option[data-current-font]');if(stale)stale.remove();
          const values=[...$('#fontFamilySelect').options].map(o=>o.value);
          $('#fontFamilySelect').value=values.includes(obj.fontFamily)?obj.fontFamily:'Arial, sans-serif';
          $('#fontReadout').textContent='';
          $('#deleteBtn').textContent='Delete text';
        }
      } else if(obj.type==='shape'){
        $('#shapeKindSelect').value=obj.kind==='circle'?'circle':'rectangle';
        const noFill=(obj.fill==='transparent'||!obj.fill), noBorder=(obj.border==='transparent'||!obj.border);
        $('#fillColorInput').disabled=noFill;$('#borderColorInput').disabled=noBorder;
        $('#noFillBtn').classList.toggle('active',noFill);$('#noBorderBtn').classList.toggle('active',noBorder);
        $('#fillColorInput').value=normalizeHex(noFill?lastShapeFillColor:obj.fill,'#ffffff');$('#borderColorInput').value=normalizeHex(noBorder?lastShapeBorderColor:obj.border,'#0b75f6');$('#borderWidthInput').value=obj.borderWidth||0;$('#deleteBtn').textContent='Delete shape';
      } else if(obj.type==='source-image'){
        $('#imageHint').textContent=obj.deleted?'Image removed — click Restore image or Undo':'Existing PDF image selected';$('#deleteBtn').textContent=obj.deleted?'Restore image':'Delete image';
      } else if(obj.type==='image'){
        $('#imageHint').textContent='Added image selected';$('#deleteBtn').textContent='Delete image';
      }
    }

    function cleanFontName(s){return (s||'').replace(/["']/g,'').split(',')[0].slice(0,26)}
    function normalizeHex(v,fallback){if(/^#[0-9a-f]{6}$/i.test(v||''))return v;return fallback}

    function setField(field,value){
      const s=getSelected();if(!s)return;
      const {rec,obj}=s;
      const before=deep(obj);
      if(obj.type==='text'&&field==='fontFamily')obj.textScaleX=1;
      obj[field]=value;
      applyObjectStyle(rec,obj);
      // Text boxes should follow the visible text. When font size/family/weight/style
      // changes, recalculate the box immediately instead of letting glyphs spill out.
      if(obj.type==='text' && ['fontSize','fontFamily','fontWeight','fontStyle'].includes(field)){
        const el=rec.objectLayer.querySelector(`[data-id="${obj.id}"]`);
        if(el){
          autoSizeText(rec,obj,el);
          applyObjectStyle(rec,obj,el);
        }
      }
      updateProperties(obj);
      commitHistory();
      updateUndoState();
    }
    function setTextSetting(field,value){
      const s=getSelected();
      if(s&&s.obj.type==='text'){
        setField(field,value);
        if(!s.obj.cover){
          if(field==='fontSize')textDefaults.fontSize=value;
          if(field==='color')textDefaults.color=value;
          if(field==='fontFamily')textDefaults.fontFamily=value;
          if(field==='fontWeight')textDefaults.bold=(String(value)==='700'||String(value)==='bold');
          if(field==='underline')textDefaults.underline=!!value;
        }
        return;
      }
      if(activeTool==='addtext'){
        if(field==='fontSize')textDefaults.fontSize=value;
        if(field==='color')textDefaults.color=value;
        if(field==='fontFamily')textDefaults.fontFamily=value;
        if(field==='fontWeight')textDefaults.bold=(String(value)==='700'||String(value)==='bold');
        if(field==='underline')textDefaults.underline=!!value;
        updateProperties(null);
      }
    }
    let fontChoiceSequence=0;
    $('#fontFamilySelect').addEventListener('change',async e=>{
      const family=e.target.value;if(!family)return;
      const sequence=++fontChoiceSequence,generation=documentGeneration,id=selected?.id,page=selected?.pageNum,tool=activeTool;
      try{
        await ensureEditorFont(family);
        if(sequence!==fontChoiceSequence||generation!==documentGeneration||id!==selected?.id||page!==selected?.pageNum||tool!==activeTool)return;
        setTextSetting('fontFamily',family);
      }catch(error){showError(error,'Unable to load font');}
    });
    $('#fontSizeInput').addEventListener('change',e=>setTextSetting('fontSize',clamp(+e.target.value||20,6,160)));

    // Native color pickers fire `input` while the user is choosing a color.
    // Apply the color immediately instead of waiting for a click outside the PDF.
    const colorEditState=new WeakMap();
    function rememberColorStart(input){
      const s=getSelected();
      colorEditState.set(input,s?{rec:s.rec,obj:s.obj,before:deep(s.obj)}:{rec:null,obj:null,before:null});
    }
    function commitColorEdit(input){
      const state=colorEditState.get(input);
      colorEditState.delete(input);
      if(!state||!state.obj||!state.before)return;
      if(JSON.stringify(state.before)===JSON.stringify(state.obj))return;
      commitHistory();
      updateUndoState();
    }
    function liveTextColor(value){
      const s=getSelected();
      if(s&&s.obj.type==='text'){
        s.obj.color=value;applyObjectStyle(s.rec,s.obj);
        if(!s.obj.cover)textDefaults.color=value;
      }else if(activeTool==='addtext'){
        textDefaults.color=value;
      }
    }
    function liveShapeColor(field,value){
      const s=getSelected();
      if(s&&s.obj.type==='shape'){s.obj[field]=value;applyObjectStyle(s.rec,s.obj);}
      if(field==='fill'){defaultShapeFill=value;lastShapeFillColor=value;}
      if(field==='border'){defaultShapeBorder=value;lastShapeBorderColor=value;}
    }

    const textColorControl=$('#textColorInput');
    textColorControl.addEventListener('pointerdown',()=>rememberColorStart(textColorControl));
    textColorControl.addEventListener('focus',()=>{if(!colorEditState.has(textColorControl))rememberColorStart(textColorControl)});
    textColorControl.addEventListener('input',e=>liveTextColor(e.target.value));
    textColorControl.addEventListener('change',e=>{liveTextColor(e.target.value);commitColorEdit(textColorControl)});
    textColorControl.addEventListener('blur',()=>commitColorEdit(textColorControl));

    $('#boldBtn').addEventListener('click',()=>{
      const s=getSelected();
      const isBold=s&&s.obj.type==='text'?(String(s.obj.fontWeight)==='700'||String(s.obj.fontWeight)==='bold'):!!textDefaults.bold;
      setTextSetting('fontWeight',isBold?'400':'700');
    });
    $('#underlineBtn').addEventListener('click',()=>{
      const s=getSelected();
      const isUnderlined=s&&s.obj.type==='text'?!!s.obj.underline:!!textDefaults.underline;
      setTextSetting('underline',!isUnderlined);
    });
    $('#copyTextBtn').addEventListener('click',copySelectedTextBelow);

    const fillColorControl=$('#fillColorInput');
    fillColorControl.addEventListener('pointerdown',()=>rememberColorStart(fillColorControl));
    fillColorControl.addEventListener('focus',()=>{if(!colorEditState.has(fillColorControl))rememberColorStart(fillColorControl)});
    fillColorControl.addEventListener('input',e=>liveShapeColor('fill',e.target.value));
    fillColorControl.addEventListener('change',e=>{liveShapeColor('fill',e.target.value);commitColorEdit(fillColorControl)});
    fillColorControl.addEventListener('blur',()=>commitColorEdit(fillColorControl));

    const borderColorControl=$('#borderColorInput');
    borderColorControl.addEventListener('pointerdown',()=>rememberColorStart(borderColorControl));
    borderColorControl.addEventListener('focus',()=>{if(!colorEditState.has(borderColorControl))rememberColorStart(borderColorControl)});
    borderColorControl.addEventListener('input',e=>liveShapeColor('border',e.target.value));
    borderColorControl.addEventListener('change',e=>{liveShapeColor('border',e.target.value);commitColorEdit(borderColorControl)});
    borderColorControl.addEventListener('blur',()=>commitColorEdit(borderColorControl));
    $('#noFillBtn').addEventListener('click',()=>{const s=getSelected();if(!s||s.obj.type!=='shape')return;const turnOff=s.obj.fill!=='transparent';defaultShapeFill=turnOff?'transparent':lastShapeFillColor;setField('fill',defaultShapeFill)});
    $('#noBorderBtn').addEventListener('click',()=>{const s=getSelected();if(!s||s.obj.type!=='shape')return;const turnOff=s.obj.border!=='transparent';defaultShapeBorder=turnOff?'transparent':lastShapeBorderColor;setField('border',defaultShapeBorder)});
    $('#shapeKindSelect').addEventListener('change',e=>{
      const kind=e.target.value==='circle'?'circle':'rectangle';
      defaultShapeKind=kind;
      const s=getSelected();
      if(s&&s.obj.type==='shape')setField('kind',kind);
    });
    $('#borderWidthInput').addEventListener('change',e=>{defaultShapeBorderWidth=clamp(+e.target.value||0,0,20);setField('borderWidth',defaultShapeBorderWidth)});
    $('#deleteBtn').addEventListener('click',deleteSelected);
    $('#addImageBtn').addEventListener('click',()=>imageInput.click());

    function copySelectedTextBelow(){
      const s=getSelected();if(!s||s.obj.type!=='text'||s.obj.deleted)return;const {rec,obj}=s;
      const clone=deep(obj);clone.id=uid();clone.x=obj.x;clone.y=clamp(obj.y+Math.max(obj.h,obj.fontSize*1.18)+4,0,rec.viewport.height-obj.fontSize*1.2);clone.cover=false;clone.minCoverW=0;clone.minCoverH=0;delete clone.sourceHitIndex;
      addObject(rec,clone,true);selectObject(rec.pageNum,clone.id);startTextEditing(rec,clone);showToast('Text copied below with the same font, size and color.');
    }

    function deleteSelected(){
      const s=getSelected(); if(!s)return; const {rec,obj}=s;
      if(obj.type==='text'&&obj.cover){
        const before={text:obj.text,deleted:!!obj.deleted};
        let el=rec.objectLayer.querySelector(`[data-id="${obj.id}"]`);
        if(obj.deleted){
          obj.deleted=false;
          obj.text=obj.originalText!=null?obj.originalText:before.text;
        }else{
          obj.deleted=true;
          obj.text='';
        }
        if(el){el.remove();rec.objectLayer.querySelector(`.text-move-handle[data-for="${obj.id}"]`)?.remove();el=renderObject(rec,obj);selectObject(rec.pageNum,obj.id);}
        applyObjectStyle(rec,obj,el);
        updateProperties(obj);
        refreshLayers(rec.pageNum);
        commitHistory();
        updateUndoState();
        showToast(obj.deleted?'Existing PDF text deleted.':'Original PDF text restored.');
        return;
      }
      if(obj.type==='source-image'){
        const before=obj.deleted;obj.deleted=!obj.deleted;applyObjectStyle(rec,obj);updateProperties(obj);refreshLayers(rec.pageNum);
        const hit=obj.sourceImageHitIndex!=null?rec.imageHitLayer.children[obj.sourceImageHitIndex]:null;if(hit)hit.style.pointerEvents=obj.deleted?'none':'inherit';
        commitHistory();updateUndoState();showToast(obj.deleted?'Image removed.':'Image restored.');return;
      }
      const clone=deep(obj); const idx=rec.objects.findIndex(o=>o.id===obj.id); const el=rec.objectLayer.querySelector(`[data-id="${obj.id}"]`); if(el)el.remove();
      const sc=rec.objectLayer.querySelector(`.pdf-source-cover[data-for="${obj.id}"]`);if(sc)sc.remove();
      const mh=rec.objectLayer.querySelector(`.text-move-handle[data-for="${obj.id}"]`);if(mh)mh.remove();
      rec.objects.splice(idx,1);
      if(obj.sourceHitIndex!=null && rec.textLayer.children[obj.sourceHitIndex]) rec.textLayer.children[obj.sourceHitIndex].style.pointerEvents='inherit';
      syncLayerOrder(rec);
      commitHistory();updateUndoState();clearSelection();refreshLayers(rec.pageNum);
    }

    function finishTextEditing(){const el=document.activeElement;if(el?.isContentEditable)el.blur();}
    function captureState(){return {selection:selected?{...selected}:null,currentPage,order:pageOrder.slice(),pages:pageOrder.map(key=>{const rec=pageRecords.get(key);return {key,rotation:rec.rotation||0,objects:rec.objects.map(deep)};})};}
    function stateSignature(state=captureState()){
      return JSON.stringify({order:state.order,pages:state.pages.map(p=>({key:p.key,rotation:p.rotation,objects:p.objects.filter(o=>!(o.cover&&!sourceTextNeedsReplacement(o))&&!(o.type==='source-image'&&!o.deleted)).map(o=>{const c={...o};delete c.sourceHitIndex;delete c.sourceImageHitIndex;return c;})}))});
    }
    function resetHistory(){history=[];redoHistory=[];committedState=captureState();savedSignature=stateSignature();updateUndoState();}
    function commitHistory(){
      if(applyingHistory)return;
      const after=captureState();
      if(!committedState){committedState=after;return;}
      if(JSON.stringify(after)===JSON.stringify(committedState))return;
      if(stateSignature(after)===stateSignature(committedState)){committedState=after;return;}
      history.push({before:committedState,after});if(history.length>40)history.shift();
      redoHistory=[];committedState=after;updateUndoState();
    }
    function restoreState(state){
      applyingHistory=true;clearSelection();
      try{
        pageOrder=state.order.slice();pageRecords.clear();workspace.replaceChildren();
        for(const p of state.pages){
          const rec=pageBank.get(p.key);if(!rec)continue;
          rec.rotation=p.rotation;rec.objects=p.objects.map(deep);pageRecords.set(p.key,rec);workspace.appendChild(rec.holder);
          rec.objectLayer.replaceChildren();for(const hit of rec.textLayer.children)hit.style.pointerEvents='inherit';
          syncSourceImageHits(rec);
          rec.objects.forEach(o=>{if(o.cover){const hit=[...rec.textLayer.children].find(h=>+h.dataset.sourceIndex===o.sourceItemIndex);if(hit){o.sourceHitIndex=[...rec.textLayer.children].indexOf(hit);hit.style.pointerEvents='none';}}renderObject(rec,o);});
          updatePageZoom(rec);pageObserver?.observe(rec.holder);requestSourceTextPreview(rec);
        }
        fitPageWidthsIfNeeded();
        currentPage=pageOrder.includes(state.currentPage)?state.currentPage:pageOrder[0];updatePageNumbers();refreshLayers();if(state.selection&&pageRecords.get(state.selection.pageNum)?.objects.some(o=>o.id===state.selection.id))selectObject(state.selection.pageNum,state.selection.id);committedState=captureState();
      }finally{applyingHistory=false;updateUndoState();}
    }
    function undo(){if(exportInProgress||loadingDocument)return;finishTextEditing();const action=history.pop();if(action){redoHistory.push(action);restoreState(action.before);showToast('Undone');}updateUndoState();}
    function redo(){if(exportInProgress||loadingDocument)return;finishTextEditing();const action=redoHistory.pop();if(action){history.push(action);restoreState(action.after);showToast('Redone');}updateUndoState();}
    function updateUndoState(){undoBtn.disabled=!history.length;$('#redoBtn').disabled=!redoHistory.length;}
    function hasUnsavedChanges(){return !!pdfDoc && stateSignature()!==savedSignature;}
    function confirmDiscard(){finishTextEditing();return !hasUnsavedChanges()||window.confirm('You have unsaved changes. If you continue, your edits will be lost.');}
    window.addEventListener('beforeunload',e=>{if(hasUnsavedChanges()){e.preventDefault();e.returnValue='';}});
    document.addEventListener('keydown',e=>{
      if(!(e.ctrlKey||e.metaKey)||exportInProgress||document.querySelector('dialog[open]'))return;
      const key=e.key.toLowerCase(),active=document.activeElement;
      if(active && ['INPUT','TEXTAREA','SELECT'].includes(active.tagName))return;
      if(key==='z'||(key==='y'&&e.ctrlKey)){e.preventDefault();e.stopPropagation();(e.shiftKey||key==='y'?redo:undo)();}
    },true);

    function setActiveTool(tool){
      activeTool=tool;
      shapeDrawArmed=(tool==='shape');
      $$('.tool[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool===tool));
      for(const rec of pageRecords.values()){
        rec.textLayer.style.pointerEvents=(tool==='text')?'auto':'none';
        rec.imageHitLayer.style.pointerEvents=(tool==='image')?'auto':'none';
      }
      if(tool==='text')showToast('Edit Text: click existing PDF text to edit or delete it.');
      if(tool==='addtext'){clearSelection();updateProperties(null);showToast('Add Text: choose style, then click anywhere on the PDF. A visible sample text box will appear there.');}
      if(tool==='shape') showToast(`Drag once to draw a ${defaultShapeKind==='circle'?'circle / oval':'rectangle'}.`);
      if(tool==='image'){clearSelection();updateProperties(null);showToast('Images: add/upload an image, or paste one directly with Ctrl+V.');}
      else if(tool!=='addtext'&&tool!=='image'&&!selected) propertybar.classList.remove('show');
      refreshLayers();
    }

    $('#toolbar').addEventListener('click',e=>{
      const b=e.target.closest('.tool');if(!b)return;const t=b.dataset.tool;
      if(t==='shape'){
        e.stopPropagation();
        const r=b.getBoundingClientRect();
        shapeMenu.style.top=(r.bottom+6)+'px';
        shapeMenu.style.left=Math.min(window.innerWidth-185,Math.max(8,r.left))+'px';
        shapeMenu.classList.toggle('show');
        return;
      }
      if(t==='text'||t==='addtext'||t==='image'){shapeMenu.classList.remove('show');setActiveTool(t);return}
      if(t==='undo'){undo();return}
      if(t==='redo'){redo();return}
      if(t==='zoomin'){setZoom(zoom+.15);return}
      if(t==='zoomout'){setZoom(zoom-.15);return}
      if(t==='download'){downloadEdited();return}
    });
    $('#downloadBtnTop').addEventListener('click',downloadEdited);
    const renameDialog=$('#renamePdfDialog'),pdfNameInput=$('#pdfNameInput');
    $('#renamePdfBtn').addEventListener('click',()=>{
      if(exportInProgress)return;finishTextEditing();pdfNameInput.value=originalFileName;
      pdfNameInput.setCustomValidity('');renameDialog.showModal();pdfNameInput.focus();pdfNameInput.select();
    });
    $('#cancelRenamePdf').addEventListener('click',()=>renameDialog.close());
    pdfNameInput.addEventListener('input',()=>pdfNameInput.setCustomValidity(''));
    $('#renamePdfForm').addEventListener('submit',e=>{
      e.preventDefault();if(exportInProgress)return;
      const name=normalizePdfName(pdfNameInput.value);
      if(!name){pdfNameInput.setCustomValidity('Enter a PDF filename.');pdfNameInput.reportValidity();return;}
      originalFileName=name;$('#fileName').textContent=name;renameDialog.close();showToast('PDF name updated.');
    });
    function normalizePdfName(value){
      const base=String(value).replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g,'').trim().replace(/(?:\.pdf)+$/i,'').replace(/[.\s]+$/g,'').trim();
      return base?base+'.pdf':'';
    }
    toggleLayersBtn.addEventListener('click',()=>{
      layersOpen=!layersOpen;
      layersPanel.classList.toggle('hidden',!layersOpen);
      toggleLayersBtn.classList.toggle('active',layersOpen);
      if(layersOpen){positionLayersPanel();refreshLayers();}
    });
    closeLayersBtn.addEventListener('click',()=>{layersOpen=false;layersPanel.classList.add('hidden');toggleLayersBtn.classList.remove('active');refreshLayers();});
    window.addEventListener('resize',()=>{if(layersOpen)positionLayersPanel()});

    imageInput.addEventListener('change',e=>{
      const f=e.target.files&&e.target.files[0];if(!f)return;if(f.size>20*1024*1024){showError('Maximum image size is 20 MB.');e.target.value='';return;}if(!/^image\/(png|jpeg|webp)$/.test(f.type)){showError('Use a PNG, JPEG or WebP image.');return;}const reader=new FileReader();reader.onload=()=>{
        rememberImageAsset(reader.result,f.name||'Image');
        addImageFromSource(reader.result,f.name||'Image',true);
      };reader.readAsDataURL(f);e.target.value='';
    });


    // Paste images directly from the clipboard (Ctrl+V / Cmd+V).
    // Text fields/contenteditable keep their normal paste behavior.
    document.addEventListener('paste',e=>{
      if(exportInProgress || editorView.classList.contains('hidden')) return;
      const active=document.activeElement;
      if(active && (active.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(active.tagName))) return;
      const dt=e.clipboardData;
      if(!dt) return;
      let imageFile=null;
      for(const item of (dt.items||[])){
        if(item.kind==='file' && /^image\//i.test(item.type||'')){
          imageFile=item.getAsFile();
          if(imageFile) break;
        }
      }
      if(!imageFile && dt.files){
        imageFile=[...dt.files].find(f=>/^image\//i.test(f.type||''))||null;
      }
      if(!imageFile) return;
      if(imageFile.size>20*1024*1024){showError('Maximum image size is 20 MB.');return;}
      e.preventDefault();
      const reader=new FileReader();
      reader.onload=()=>{
        const name=imageFile.name && imageFile.name!=='image.png' ? imageFile.name : 'Pasted image';
        rememberImageAsset(reader.result,name);
        addImageFromSource(reader.result,name,true);
        showToast('Image pasted from clipboard.');
      };
      reader.readAsDataURL(imageFile);
    });

    function setZoom(v){zoom=clamp(Math.round(v*100)/100,.12,2.2);for(const rec of pageRecords.values())updatePageZoom(rec);showToast(`Zoom ${Math.round(zoom*100)}%`,800)}
    function updatePageZoom(rec){
      const w=rec.viewport.width,h=rec.viewport.height,r=rec.rotation||0;
      const transform=r===90?`translate(${h}px,0) rotate(90deg)`:r===180?`translate(${w}px,${h}px) rotate(180deg)`:r===270?`translate(0,${w}px) rotate(270deg)`:'';
      rec.shell.style.transform=`scale(${zoom}) ${transform}`;
      rec.holder.style.width=((r%180?h:w)*zoom)+'px';rec.holder.style.height=((r%180?w:h)*zoom)+'px';
    }
    function fitDocument(){
      if(!pageOrder.length)return;
      // Portrait and rotated landscape pages share a zoom that fits the widest page.
      let width=0;
      for(const key of pageOrder){const rec=pageRecords.get(key);if(rec)width=Math.max(width,(rec.rotation||0)%180?rec.viewport.height:rec.viewport.width);}
      if(!width)return;
      zoom=Math.max(.01,Math.min(1,Math.max(1,workspace.clientWidth-32)/width)*.9);
      for(const rec of pageRecords.values())updatePageZoom(rec);
    }
    function fitPageWidthsIfNeeded(){
      const available=Math.max(1,workspace.clientWidth-32);
      if(pageOrder.some(key=>{const rec=pageRecords.get(key);return rec&&((rec.rotation||0)%180?rec.viewport.height:rec.viewport.width)*zoom>available;}))fitDocument();
    }
    window.addEventListener('resize',()=>{if(pdfDoc){fitDocument();positionLayersPanel();}});
    function markActiveThumbnail(){for(const b of $('#pageThumbnails').children){const active=b.dataset.page===currentPage;b.classList.toggle('active',active);b.querySelector('.thumb-jump')?.setAttribute('aria-current',active?'page':'false');}}
    function updateThumbnailImage(rec){
      const img=$('#pageThumbnails').querySelector(`[data-page="${rec.pageNum}"] img`);rec.previewThumbnail=null;if(img&&rec.thumbnail)img.src=rec.thumbnail;
      if(!$('#pagePanel').classList.contains('hidden')){clearTimeout(rec.thumbTimer);rec.thumbTimer=setTimeout(()=>renderThumbnail(rec),100);}
    }
    let thumbnailObserver=null;
    async function renderThumbnail(rec){
      if(rec.thumbRunning)return;rec.thumbRunning=true;const generation=documentGeneration;
      try{
        const c=document.createElement('canvas'),w=100,h=Math.round(w*rec.viewport.height/rec.viewport.width);c.width=w;c.height=h;const ctx=c.getContext('2d'),scale=w/rec.viewport.width;
        if(rec.hydrated)ctx.drawImage(rec.canvas,0,0,w,h);
        else if(rec.isBlank){ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);}
        else await rec.page.render({canvasContext:ctx,viewport:rec.page.getViewport({scale:w/rec.unitViewport.width})}).promise;
        ctx.save();ctx.scale(scale,scale);
        for(const o of rec.objects){
          if(o.deleted||o.isPlaceholder||(o.cover&&!sourceTextNeedsReplacement(o)))continue;
          if(o.type==='text'){ctx.save();ctx.translate(o.x,o.y);ctx.rotate(o.angle||0);ctx.scale(o.textScaleX||1,1);ctx.fillStyle=o.color;ctx.font=`${o.fontStyle||'normal'} ${o.fontWeight||400} ${o.fontSize}px ${compatibleFont(o.fontFamily)}`;ctx.textBaseline='alphabetic';String(o.text).split('\n').forEach((line,i)=>ctx.fillText(line,0,textBaselineOffset(o)+i*o.fontSize*1.16));ctx.restore();}
          else if(o.type==='shape'){ctx.beginPath();if(o.kind==='circle')ctx.ellipse(o.x+o.w/2,o.y+o.h/2,o.w/2,o.h/2,0,0,2*Math.PI);else ctx.rect(o.x,o.y,o.w,o.h);if(o.fill&&o.fill!=='transparent'){ctx.fillStyle=o.fill;ctx.fill();}if(o.border&&o.border!=='transparent'&&o.borderWidth){ctx.strokeStyle=o.border;ctx.lineWidth=o.borderWidth;ctx.stroke();}}
          else if(o.type==='image'){const image=new Image();await new Promise(resolve=>{image.onload=image.onerror=resolve;image.src=o.src;});if(image.naturalWidth){ctx.save();ctx.translate(o.x,o.y);ctx.rotate(o.angle||0);ctx.drawImage(image,0,0,o.w,o.h);ctx.restore();}}
        }
        ctx.restore();if(generation!==documentGeneration)return;
        rec.previewThumbnail=c.toDataURL();const img=$('#pageThumbnails').querySelector(`[data-page="${rec.pageNum}"] img`);if(img)img.src=rec.previewThumbnail;
      }catch(_){}finally{rec.thumbRunning=false;}
    }
    function reorderPage(key,toIndex){
      finishTextEditing();const from=pageOrder.indexOf(key);if(from<0)return;toIndex=clamp(toIndex,0,pageOrder.length-1);
      if(from===toIndex)return;pageOrder.splice(from,1);pageOrder.splice(toIndex,0,key);
      pageOrder.forEach(k=>workspace.appendChild(pageRecords.get(k).holder));updatePageNumbers();commitHistory();
    }
    function refreshThumbnails(){
      const panel=$('#pageThumbnails');thumbnailObserver?.disconnect();panel.replaceChildren();thumbnailObserver=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){const rec=pageRecords.get(e.target.dataset.page);if(rec)renderThumbnail(rec);}},{root:$('#pagePanel'),rootMargin:'150px'});
      pageOrder.forEach((key,i)=>{
        const rec=pageRecords.get(key),row=document.createElement('div');row.className='page-thumb';row.dataset.page=key;row.draggable=true;
        const jump=document.createElement('button');jump.type='button';jump.className='thumb-jump';jump.title=jump.ariaLabel='Go to page '+(i+1);
        const img=document.createElement('img');img.alt='';img.src=rec.previewThumbnail||rec.thumbnail||assetUrl('assets/page-placeholder.svg');img.style.transform=`rotate(${rec.rotation||0}deg)`;
        const label=document.createElement('span');label.textContent='Page '+(i+1);jump.append(img,label);
        jump.addEventListener('click',()=>{currentPage=key;rec.holder.scrollIntoView({behavior:'smooth',block:'start'});hydratePage(rec);markActiveThumbnail();});
        jump.addEventListener('keydown',e=>{if(e.altKey&&(e.key==='ArrowUp'||e.key==='ArrowDown')){e.preventDefault();reorderPage(key,i+(e.key==='ArrowUp'?-1:1));$('#pageThumbnails').querySelector(`[data-page="${key}"] .thumb-jump`)?.focus();}});
        row.addEventListener('dragstart',e=>{e.dataTransfer.setData('text/plain',key);});row.addEventListener('dragover',e=>e.preventDefault());
        row.addEventListener('drop',e=>{e.preventDefault();const source=e.dataTransfer.getData('text/plain');const old=pageOrder.indexOf(source);if(old>=0)reorderPage(source,old<i?i-1:i);});
        row.append(jump);panel.append(row);thumbnailObserver.observe(row);
      });markActiveThumbnail();
    }
    function setPagePanelOpen(open){
      $('#pagePanel').classList.toggle('hidden',!open);editorView.classList.toggle('thumbnails-open',open);
      $('#togglePages').setAttribute('aria-expanded',String(open));$('#togglePages').classList.toggle('active',open);
      syncEditorHeaderHeight();fitDocument();
      if(open)for(const row of $('#pageThumbnails').children){const rec=pageRecords.get(row.dataset.page);if(rec&&!rec.previewThumbnail)thumbnailObserver?.observe(row);}
    }
    function syncEditorHeaderHeight(){document.documentElement.style.setProperty('--editor-header-height',$('.topbar').getBoundingClientRect().height+'px');}
    new ResizeObserver(syncEditorHeaderHeight).observe($('.topbar'));
    $('#togglePages').addEventListener('click',()=>setPagePanelOpen($('#pagePanel').classList.contains('hidden')));
    $('#closePages').addEventListener('click',()=>setPagePanelOpen(false));
    let pageScrollFrame=0;
    function updateVisiblePage(){
      pageScrollFrame=0;if(!pdfDoc||!pageOrder.length)return;
      const header=$('.topbar').getBoundingClientRect().bottom;
      const rail=window.innerWidth<=720&&!$('#pagePanel').classList.contains('hidden')?148:0;
      const top=header+rail,target=top+(window.innerHeight-top)*.35;let next=null,best=Infinity;
      for(const key of pageOrder){const rec=pageRecords.get(key),box=rec.holder.getBoundingClientRect();if(box.bottom<=top||box.top>=window.innerHeight)continue;
        const distance=target<box.top?box.top-target:target>box.bottom?target-box.bottom:0;if(distance<best){best=distance;next=key;}
      }
      if(next&&next!==currentPage){currentPage=next;markActiveThumbnail();}
    }
    window.addEventListener('scroll',()=>{if(!pageScrollFrame)pageScrollFrame=requestAnimationFrame(updateVisiblePage);},{passive:true});



    $$('.shape-choice').forEach(btn=>btn.addEventListener('click',e=>{
      e.stopPropagation();
      defaultShapeKind=btn.dataset.shapeKind==='circle'?'circle':'rectangle';
      $$('.shape-choice').forEach(x=>x.classList.toggle('active',x===btn));
      shapeMenu.classList.remove('show');
      setActiveTool('shape');
    }));
    document.addEventListener('pointerdown',e=>{
      if(!e.target.closest('#shapeMenu')&&!e.target.closest('#shapeTool'))shapeMenu.classList.remove('show');
    });

    // Color palette
    const colors=['#0b75f6','#0ea5e9','#06b6d4','#10b981','#22c55e','#84cc16','#eab308','#f59e0b','#f97316','#ef4444','#dc2626','#ec4899','#a855f7','#7c3aed','#4f46e5','#111827','#374151','#6b7280','#9ca3af','#d1d5db','#ffffff','#fff7ed','#fef3c7','#ecfccb','#dcfce7','#e0f2fe','#e0e7ff','#f3e8ff','#fce7f3','#fee2e2','#f5f5f4','#000000'];
    colors.forEach(c=>{const b=document.createElement('button');b.className='swatch';b.style.background=c;b.title=c;b.addEventListener('click',()=>{defaultShapeFill=c;lastShapeFillColor=c;const s=getSelected();if(s&&s.obj.type==='shape')setField('fill',c);$('#fillColorInput').value=c;palette.classList.remove('show')});$('#swatches').appendChild(b)});
    $('#paletteBtn').addEventListener('click',e=>{e.stopPropagation();const r=e.currentTarget.getBoundingClientRect();palette.style.top=(r.bottom+8)+'px';palette.style.left=Math.min(window.innerWidth-260,Math.max(8,r.left))+'px';palette.classList.toggle('show')});
    $('#paletteCustom').addEventListener('change',e=>{defaultShapeFill=e.target.value;lastShapeFillColor=e.target.value;const s=getSelected();if(s&&s.obj.type==='shape')setField('fill',e.target.value);palette.classList.remove('show')});
    document.addEventListener('pointerdown',e=>{if(!e.target.closest('#palette')&&!e.target.closest('#paletteBtn'))palette.classList.remove('show')});

    document.addEventListener('keydown',e=>{
      if(document.querySelector('dialog[open]'))return;
      if((e.key==='Delete'||e.key==='Backspace') && selected && !document.activeElement.isContentEditable && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)){e.preventDefault();deleteSelected()}
      if(e.key==='Escape'){clearSelection();palette.classList.remove('show')}
      if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)&&selected&&!document.activeElement.isContentEditable&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)){const state=getSelected();if(state&&state.obj.type!=='source-image'&&!state.obj.deleted){e.preventDefault();const step=e.shiftKey?10:1;state.obj.x+=e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0;state.obj.y+=e.key==='ArrowUp'?-step:e.key==='ArrowDown'?step:0;applyObjectStyle(state.rec,state.obj);commitHistory();}}
    });

    let permanentRedactionBaseActive = false;

    function nearEqual(a,b,tol=.35){return Math.abs((+a||0)-(+b||0))<=tol}
    function sourceTextNeedsReplacement(obj){
      if(!obj || obj.type!=='text' || !obj.cover) return false;
      if(obj.deleted) return true;
      if(String(obj.text||'')!==String(obj.originalText||'')) return true;
      if(!nearEqual(obj.x,obj.sourceDisplayX!=null?obj.sourceDisplayX:obj.sourceX) || !nearEqual(obj.y,obj.sourceDisplayY!=null?obj.sourceDisplayY:obj.sourceY)) return true;
      if(!nearEqual(obj.fontSize,obj.sourceFontSize,.15)) return true;
      if(String(obj.fontFamily||'')!==String(obj.sourceFontFamily||'')) return true;
      if(String(obj.fontWeight||'400')!==String(obj.sourceFontWeight||'400')) return true;
      if(String(obj.fontStyle||'normal')!==String(obj.sourceFontStyle||'normal')) return true;
      if(!!obj.underline!==!!obj.sourceUnderline) return true;
      if(normalizeHex(obj.color,'#000000')!==normalizeHex(obj.sourceColor||obj.color,'#000000')) return true;
      return false;
    }

    let engineWorker=null,engineReady=null,engineSequence=0;
    const enginePending=new Map();
    function rejectEngineRequests(error){for(const req of enginePending.values()){clearTimeout(req.timer);req.reject(error);}enginePending.clear();}
    function rawEngineRequest(type,data={},transfer=[]){
      return new Promise((resolve,reject)=>{
        const id=++engineSequence,timer=setTimeout(()=>{enginePending.delete(id);reject(new Error('PDF processing took too long. Try a smaller PDF.'));engineWorker?.terminate();engineWorker=null;engineReady=null;rejectEngineRequests(new Error('PDF processing was stopped.'));},60000);
        enginePending.set(id,{resolve,reject,timer});engineWorker.postMessage({id,type,...data},transfer);
      });
    }
    async function ensureEngine(){
      if(!engineReady){
        engineReady=(async()=>{
          let readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
          engineWorker=new Worker(assetUrl('assets/pdf-engine-worker.js'),{type:'module'});
          engineWorker.onmessage=({data})=>{if(data.ready){readyResolve();return;}const req=enginePending.get(data.id);if(!req)return;enginePending.delete(data.id);clearTimeout(req.timer);data.ok?req.resolve(data):req.reject(new Error(data.error));};
          engineWorker.onerror=()=>{const e=new Error('The PDF removal tools could not load. Reload the page and try again.');readyReject(e);rejectEngineRequests(e);engineWorker?.terminate();engineWorker=null;engineReady=null;};
          await withTimeout(ready,30000,'The PDF removal tools could not load. Reload the page and try again.');
          const copy=originalBytes.slice(0);await rawEngineRequest('init',{bytes:copy},[copy]);
        })().catch(e=>{engineWorker?.terminate();engineWorker=null;engineReady=null;throw e;});
      }await engineReady;
    }
    async function engineRequest(type,data){await ensureEngine();return rawEngineRequest(type,data);}
    async function cacheRasterImages(rec){
      await ensureEngine();if(rec.rasterCacheWorker===engineWorker)return;
      const images=[];
      // PDF.js uses different object IDs for display and operator-list intents.
      // Use the already rendered display objects for the original image pixels.
      const display=[...(rec.page._intentStates?.values()||[])].find(state=>state.displayReadyCapability)?.operatorList;
      const displayIds=display?display.argsArray.filter((args,i)=>[pdfjsLib.OPS.paintImageXObject,pdfjsLib.OPS.paintInlineImageXObject,pdfjsLib.OPS.paintJpegXObject].includes(display.fnArray[i])).map(args=>args[0]):[];
      for(const hit of rec.imageHitLayer.children){
        if(!hit.dataset.imageId)continue;
        const id=rec.page.objs.has(hit.dataset.imageId)?hit.dataset.imageId:displayIds[+hit.dataset.imageOrdinal],store=String(id).startsWith('g_')?rec.page.commonObjs:rec.page.objs;
        if(!store.has(id))continue;const image=store.get(id);if(!image)continue;
        const W=image.width,H=image.height;let pixels;
        if(image.bitmap){const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;canvas.getContext('2d').drawImage(image.bitmap,0,0);pixels=canvas.getContext('2d').getImageData(0,0,W,H).data;canvas.width=canvas.height=1;}
        else if(image.data?.length===W*H*4)pixels=image.data.slice();
        else if(image.data?.length===W*H*3){pixels=new Uint8ClampedArray(W*H*4);for(let i=0,j=0;i<image.data.length;i+=3,j+=4){pixels[j]=image.data[i];pixels[j+1]=image.data[i+1];pixels[j+2]=image.data[i+2];pixels[j+3]=255;}}
        if(pixels)images.push({quad:JSON.parse(hit.dataset.pdfQuad),occurrence:+hit.dataset.occurrence,width:W,height:H,pixels});
      }
      if(images.length)await engineRequest('raster',{pageNumber:rec.originalPageNum,images});rec.rasterCacheWorker=engineWorker;
    }
    function jobForPage(rec){return {pageNumber:rec.originalPageNum,width:rec.viewport.width,height:rec.viewport.height,items:rec.objects.filter(sourceTextNeedsReplacement).map(o=>({sourcePdfPoint:o.sourcePdfPoint,sourceRedactQuad:o.sourceRedactQuad,sourceItemIndex:o.sourceItemIndex,originalText:o.originalText,pixelErase:o.pixelErase||null})),images:rec.objects.filter(o=>o.type==='source-image'&&o.deleted).map(o=>({x:o.x,y:o.y,w:o.w,h:o.h,sourcePdfQuad:o.sourcePdfQuad,sourceImageOccurrence:o.sourceImageOccurrence}))};}
    async function buildPermanentlyRedactedBase(){
      const jobs=pageOrder.map(k=>pageRecords.get(k)).filter(r=>!r.isBlank).map(jobForPage).filter(j=>j.items.length||j.images.length);
      permanentRedactionBaseActive=!!jobs.length;
      if(!jobs.length)return originalBytes.slice(0);
      setBusy(true,'Safely removing selected PDF content…');
      return (await engineRequest('remove',{jobs})).bytes;
    }

    function pdfRgb(hex){
      const h=normalizeHex(hex,'#000000').slice(1);
      return PDFLib.rgb(parseInt(h.slice(0,2),16)/255,parseInt(h.slice(2,4),16)/255,parseInt(h.slice(4,6),16)/255);
    }

    async function normalizeImageToPngDataUrl(src){
      if(/^data:image\/png/i.test(src))return src;
      if(/^data:image\/(jpe?g)/i.test(src))return src;
      return await new Promise((resolve,reject)=>{
        const img=new Image();
        img.onload=()=>{
          const c=document.createElement('canvas');c.width=img.naturalWidth||img.width;c.height=img.naturalHeight||img.height;
          const ctx=c.getContext('2d');ctx.drawImage(img,0,0);resolve(c.toDataURL('image/png'));
        };
        img.onerror=reject;img.src=src;
      });
    }

    async function embedDataImage(out,src){
      const normalized=await normalizeImageToPngDataUrl(src);
      return /^data:image\/(jpe?g)/i.test(normalized)?out.embedJpg(normalized):out.embedPng(normalized);
    }

    function textBaselineOffset(obj){
      const ctx=document.createElement('canvas').getContext('2d');ctx.font=`${obj.fontStyle||'normal'} ${obj.fontWeight||400} ${obj.fontSize}px ${compatibleFont(obj.fontFamily)}`;
      const m=ctx.measureText('Hg'),a=m.fontBoundingBoxAscent||obj.fontSize*.8,d=m.fontBoundingBoxDescent||obj.fontSize*.2;
      return a+(obj.fontSize*1.16-a-d)/2;
    }
    function compatibleFont(family){
      if(/^RiloPdf\d+_\d+$/.test(family||''))return family;
      if(/^Rilo(Sans|Serif|Mono|Unicode|Bookman|Palatino|Schoolbook|Narrow)$/.test(family||''))return family;
      const name=String(family||'').toLowerCase();
      if(/bookman/.test(name))return 'RiloBookman';
      if(/palatino|p052/.test(name))return 'RiloPalatino';
      if(/schoolbook|c059/.test(name))return 'RiloSchoolbook';
      if(/narrow/.test(name))return 'RiloNarrow';
      if(/courier|mono/.test(name))return 'RiloMono';
      if(/times|georgia|serif/.test(name)&&!name.includes('sans'))return 'RiloSerif';
      return 'RiloSans';
    }
    const fontBytesCache=new Map();
    async function fontBytes(path){if(!fontBytesCache.has(path))fontBytesCache.set(path,fetch(assetUrl(path)).then(r=>{if(!r.ok)throw new Error('An export font could not load. Please reload and try again.');return r.arrayBuffer();}));return fontBytesCache.get(path);}
    async function exportFont(out,obj){
      if(!out.riloFonts){out.riloFonts=new Map();out.registerFontkit(window.fontkit);}
      const source=sourcePdfFonts.get(obj.fontFamily);
      if(source){
        if([...String(obj.text)].every(c=>c==='\n'||source.supported.has(c.codePointAt(0)))){
          if(!out.riloFonts.has(obj.fontFamily))out.riloFonts.set(obj.fontFamily,out.embedFont(source.bytes,{subset:false}));return out.riloFonts.get(obj.fontFamily);
        }
        obj.fontFamily=source.fallback;
      }
      const family=compatibleFont(obj.fontFamily),bold=Number(obj.fontWeight)>=600||obj.fontWeight==='bold',italic=obj.fontStyle==='italic';
      const customFonts={
        RiloBookman:{stem:'URWBookman',regular:'Light',bold:'Demi',italic:'LightItalic',boldItalic:'DemiItalic'},
        RiloPalatino:{stem:'P052',regular:'Roman',bold:'Bold',italic:'Italic',boldItalic:'BoldItalic'},
        RiloSchoolbook:{stem:'C059',regular:'Roman',bold:'Bold',italic:'Italic',boldItalic:'BdIta'},
        RiloNarrow:{stem:'NimbusSansNarrow',regular:'Regular',bold:'Bold',italic:'Oblique',boldItalic:'BoldOblique'}
      },custom=customFonts[family];
      const stem=custom?custom.stem:family==='RiloMono'?'NimbusMonoPS':family==='RiloSerif'?'NimbusRoman':family==='RiloUnicode'?'DejaVuSans':'NimbusSans';
      const variant=custom?'-'+custom[bold?(italic?'boldItalic':'bold'):(italic?'italic':'regular')]:stem==='DejaVuSans'?(bold?'-Bold':''):'-'+(bold?(italic?'BoldItalic':'Bold'):(italic?'Italic':'Regular'));
      const path='assets/fonts/'+stem+variant+(stem==='DejaVuSans'?'.ttf':'.otf');
      if(!out.riloFonts.has(path))out.riloFonts.set(path,out.embedFont(await fontBytes(path),{subset:false}));
      const font=await out.riloFonts.get(path);
      const supported=new Set(font.getCharacterSet());
      if([...String(obj.text)].some(c=>c!=='\n'&&!supported.has(c.codePointAt(0)))){
        if(family==='RiloUnicode')throw new Error('This font cannot export some characters in your text. Choose a supported font or text.');
        obj.fontFamily='RiloUnicode';const rec=pageRecords.get(selected?.pageNum)||[...pageRecords.values()].find(r=>r.objects.includes(obj));if(rec)applyObjectStyle(rec,obj);
        return exportFont(out,obj);
      }
      return font;
    }
    async function drawObjectToPdf(out,page,rec,obj){
      if(obj.type==='source-image')return; // Removed from source operators, never covered.
      const H=rec.viewport.height,r={x:obj.x,y:H-obj.y-obj.h,w:obj.w,h:obj.h,sx:1,sy:1};
      if(obj.type==='shape'){
        const bw=obj.border&&obj.border!=='transparent'?Math.max(0,obj.borderWidth||0):0;
        // CSS borders sit inside the box; PDF strokes straddle their paths.
        const opts={x:r.x+bw/2,y:r.y+bw/2,width:Math.max(0,r.w-bw),height:Math.max(0,r.h-bw)};
        if(obj.fill&&obj.fill!=='transparent')opts.color=pdfRgb(obj.fill);
        if(bw){opts.borderColor=pdfRgb(obj.border);opts.borderWidth=bw;}
        if(opts.color||opts.borderColor){
          if(obj.kind==='circle')page.drawEllipse({x:r.x+r.w/2,y:r.y+r.h/2,xScale:Math.max(.1,(r.w-bw)/2),yScale:Math.max(.1,(r.h-bw)/2),...(opts.color?{color:opts.color}:{}),...(bw?{borderColor:opts.borderColor,borderWidth:bw}:{})});
          else page.drawRectangle(opts);
        }return;
      }
      if(obj.type==='image'){
        const image=await embedDataImage(out,obj.src),angle=obj.angle||0;
        page.drawImage(image,{x:obj.x-Math.sin(angle)*obj.h,y:H-obj.y-Math.cos(angle)*obj.h,width:r.w,height:r.h,rotate:PDFLib.radians(-angle)});return;
      }
      if(obj.type!=='text'||obj.isPlaceholder||obj.deleted||!String(obj.text||'').length||(obj.cover&&!sourceTextNeedsReplacement(obj)))return;
      const font=await exportFont(out,obj);await document.fonts.load(`${obj.fontStyle||'normal'} ${obj.fontWeight||400} ${obj.fontSize}px ${obj.fontFamily}`);
      const ctx=document.createElement('canvas').getContext('2d');ctx.font=`${obj.fontStyle||'normal'} ${obj.fontWeight||400} ${obj.fontSize}px ${obj.fontFamily}`;
      const metric=ctx.measureText('Hg'),ascent=metric.fontBoundingBoxAscent||obj.fontSize*.8,descent=metric.fontBoundingBoxDescent||obj.fontSize*.2;
      const baseline=textBaselineOffset(obj);
      const lines=String(obj.text).replace(/\r/g,'').split('\n'),angle=obj.angle||0,cos=Math.cos(angle),sin=Math.sin(angle);
      const scale=obj.textScaleX||1;
      if(scale!==1){
        page.pushOperators(PDFLib.pushGraphicsState(),PDFLib.concatTransformationMatrix(cos*scale,-sin*scale,sin,cos,obj.x,H-obj.y));
        lines.forEach((line,i)=>{const offset=baseline+i*obj.fontSize*1.16;
          page.drawText(line,{x:0,y:-offset,size:obj.fontSize,font,color:pdfRgb(obj.color),lineHeight:obj.fontSize*1.16});
          if(obj.underline&&line)page.drawLine({start:{x:0,y:-offset-obj.fontSize*.12},end:{x:font.widthOfTextAtSize(line,obj.fontSize),y:-offset-obj.fontSize*.12},thickness:obj.fontSize*.065,color:pdfRgb(obj.color)});
        });page.pushOperators(PDFLib.popGraphicsState());return;
      }
      lines.forEach((line,i)=>{
        const offset=baseline+i*obj.fontSize*1.16,x=obj.x-sin*offset,y=H-(obj.y+cos*offset);
        page.drawText(line,{x,y,size:obj.fontSize,font,color:pdfRgb(obj.color),rotate:PDFLib.radians(-angle),lineHeight:obj.fontSize*1.16});
        if(obj.underline&&line){const width=font.widthOfTextAtSize(line,obj.fontSize),u=offset+obj.fontSize*.12;
          page.drawLine({start:{x:obj.x-sin*u,y:H-obj.y-cos*u},end:{x:obj.x-sin*u+cos*width,y:H-obj.y-cos*u-sin*width},thickness:obj.fontSize*.065,color:pdfRgb(obj.color)});
        }
      });
    }


    async function downloadEdited(){
      if(!pdfDoc||exportInProgress)return;
      finishTextEditing();exportInProgress=true;clearSelection();setBusy(true,'Building high-quality PDF…');
      document.body.classList.add('exporting');
      try{
        await verifyPendingSourceChanges();
        const secureBase=await buildPermanentlyRedactedBase();
        await ensureWritingTools();
        const src=await PDFLib.PDFDocument.load(secureBase);
        const out=await PDFLib.PDFDocument.create();
        for(let i=0;i<pageOrder.length;i++){
          const rec=pageRecords.get(pageOrder[i]); if(!rec)continue;
          setBusy(true,`Exporting page ${i+1} of ${pageOrder.length}…`);
          let p;
          if(rec.isBlank){
            p=out.addPage([rec.unitViewport.width,rec.unitViewport.height]);
          }else{
            const copied=await out.copyPages(src,[rec.originalPageNum-1]);
            p=out.addPage(copied[0]);
          }
          const inv=rec.isBlank?[1/(rec.viewport.scale||1.45),0,0,-1/(rec.viewport.scale||1.45),0,rec.unitViewport.height]:pdfjsLib.Util.inverseTransform(rec.viewport.transform);
          const H=rec.viewport.height;
          p.pushOperators(PDFLib.pushGraphicsState(),PDFLib.concatTransformationMatrix(inv[0],inv[1],-inv[2],-inv[3],inv[4]+inv[2]*H,inv[5]+inv[3]*H),PDFLib.rectangle(0,0,rec.viewport.width,H),PDFLib.clip(),PDFLib.endPath());
          for(const obj of rec.objects)await drawObjectToPdf(out,p,rec,obj);
          p.pushOperators(PDFLib.popGraphicsState());
          p.setRotation(PDFLib.degrees(((p.getRotation().angle||0)+(rec.rotation||0))%360));
        }
        out.setTitle(originalFileName.replace(/\.pdf$/i,''));out.setProducer('PDFRilo');
        const bytes=await out.save({useObjectStreams:true,addDefaultPage:false});
        const blob=new Blob([bytes],{type:'application/pdf'});
        const url=URL.createObjectURL(blob);
        const a=document.createElement('a');a.href=url;a.download=originalFileName;document.body.appendChild(a);a.click();a.remove();
        setTimeout(()=>URL.revokeObjectURL(url),1500);
        committedState=captureState();savedSignature=stateSignature();
        showToast('Edited PDF downloaded.');
        setTimeout(()=>afterDownload.classList.remove('hidden'),300);
      }catch(err){console.error(err);showError(err,'Unable to download PDF');}
      finally{document.body.classList.remove('exporting');setBusy(false);exportInProgress=false;}
    }
  window.PDFRiloEditor={openFile:loadPdfFile,startBlank:startBlankDocument};
  })();
  
