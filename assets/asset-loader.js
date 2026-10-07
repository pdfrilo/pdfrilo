// External resources use the website directory, including on project Pages URLs.
window.PDFRiloHostedAssets=(()=>{
  const base=new URL('../',document.currentScript.src);
  const url=path=>new URL(path,base).href;
  let fontsReady=null;
  const resourceBytes=new Map();
  function ready(){
    if(!fontsReady)fontsReady=new Promise((resolve,reject)=>{
      const link=document.createElement('link');link.rel='stylesheet';link.href=url('assets/fonts.css');
      link.onload=resolve;
      link.onerror=()=>{link.remove();fontsReady=null;reject(new Error('PDF fonts could not load. Reload and try again.'));};
      document.head.appendChild(link);
    });
    return fontsReady;
  }
  async function getBytes(path){
    if(!resourceBytes.has(path))resourceBytes.set(path,(async()=>{
      const response=await fetch(url(path));
      if(!response.ok)throw new Error('A PDF resource could not load. Publish the complete assets folder.');
      return new Uint8Array(await response.arrayBuffer());
    })().catch(error=>{resourceBytes.delete(path);throw error;}));
    // PDF.js may transfer the returned buffer to its worker. Keep the cached copy.
    return (await resourceBytes.get(path)).slice();
  }
  class BinaryDataFactory{
    async fetch({kind,filename}){
      if(kind==='cMapUrl')return getBytes('assets/vendor/pdfjs/cmaps/'+filename);
      const folder={standardFontDataUrl:'standard_fonts',wasmUrl:'wasm'}[kind];
      if(!folder)throw new Error('Unsupported PDF resource.');
      return getBytes('assets/vendor/pdfjs/'+folder+'/'+filename);
    }
  }
  return {url,ready,pdfOptions:()=>({BinaryDataFactory,useWorkerFetch:false})};
})();
