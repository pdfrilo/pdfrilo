// The homepage does not load the editor, PDF libraries, WASM or editing fonts.
(()=>{
  const base=new URL('../',document.currentScript.src);
  const input=document.querySelector('#fileInput');
  const drop=document.querySelector('#dropZone');
  const busy=document.querySelector('#busy');
  let pending=null,opening=false;
  function script(path){return new Promise((resolve,reject)=>{
    const tag=document.createElement('script');tag.src=new URL(path,base).href;
    let timer=setTimeout(()=>{tag.remove();reject(new Error('PDF tools could not load. Check your connection and try again.'));},45000);
    tag.onload=()=>{clearTimeout(timer);resolve();};
    tag.onerror=()=>{clearTimeout(timer);tag.remove();reject(new Error('PDF tools could not load. Upload the complete assets folder and try again.'));};
    document.head.appendChild(tag);
  });}
  function ensureEditor(){
    if(window.PDFRiloEditor)return Promise.resolve(window.PDFRiloEditor);
    if(!pending)pending=(async()=>{
      if(location.protocol==='file:')throw new Error('To preview this version, use the included preview launcher or open your GitHub Pages website.');
      if(!window.PDFRiloHostedAssets)await script('assets/asset-loader.js');
      await script('assets/editor.js');
      if(!window.PDFRiloEditor)throw new Error('PDF tools could not load. Please reload.');
      return window.PDFRiloEditor;
    })().catch(error=>{pending=null;throw error;});
    return pending;
  }
  function errorDialog(error){
    document.querySelector('#errorTitle').textContent='Unable to load PDF tools';
    document.querySelector('#errorMessage').textContent=error.message;
    const dialog=document.querySelector('#errorDialog');if(!dialog.open)dialog.showModal();
  }
  async function open(file){
    if(opening)return;
    opening=true;
    busy.classList.remove('hidden');document.querySelector('#busyText').textContent='Loading PDF tools…';
    try{const editor=await ensureEditor();await (file?editor.openFile(file):editor.startBlank());}
    catch(error){errorDialog(error);}
    finally{opening=false;busy.classList.add('hidden');}
  }
  document.querySelector('#closeError').addEventListener('click',()=>document.querySelector('#errorDialog').close());
  document.querySelector('#uploadBtn').addEventListener('click',()=>input.click());
  document.querySelector('#startBlankBtn').addEventListener('click',()=>open());
  input.addEventListener('change',e=>{const file=e.target.files?.[0];e.target.value='';if(file)open(file);});
  ['dragenter','dragover'].forEach(type=>drop.addEventListener(type,e=>{e.preventDefault();drop.style.background='#eaf4ff';}));
  ['dragleave','drop'].forEach(type=>drop.addEventListener(type,e=>{e.preventDefault();drop.style.background='';}));
  drop.addEventListener('drop',e=>{const file=e.dataTransfer.files?.[0];if(file)open(file);});
  // Resolve domain metadata to the actual hosted address until a custom domain
  // is connected. Relative asset paths need no edits during that move.
  if(location.protocol!=='file:'){
    const home=base.href;
    const canonical=document.querySelector('link[rel="canonical"]');if(canonical)canonical.href=home;
    const og=document.querySelector('meta[property="og:url"]');if(og)og.content=home;
    for(const tag of document.querySelectorAll('script[type="application/ld+json"]')){
      const data=JSON.parse(tag.textContent);
      for(const entry of data['@graph']||[])if(entry.url==='./')entry.url=home;
      tag.textContent=JSON.stringify(data);
    }
  }
})();
