// External resources use the website directory, including on project Pages URLs.
window.PDFRiloHostedAssets=(()=>{
  const base=new URL('../',document.currentScript.src);
  const url=path=>new URL(path,base).href;
  let fontsReady=null,cmapReady=null;
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
    const response=await fetch(url(path));
    if(!response.ok)throw new Error('A PDF resource could not load. Publish the complete assets folder.');
    return new Uint8Array(await response.arrayBuffer());
  }
  function cmaps(){
    if(!cmapReady)cmapReady=Promise.all([
      fetch(url('assets/vendor/pdfjs/cmaps-index.json')).then(r=>{if(!r.ok)throw new Error('PDF character maps could not load.');return r.json();}),
      getBytes('assets/vendor/pdfjs/cmaps.bin')
    ]).catch(error=>{cmapReady=null;throw error;});
    return cmapReady;
  }
  class BinaryDataFactory{
    async fetch({kind,filename}){
      if(kind==='cMapUrl'){
        const [index,data]=await cmaps(),entry=index[filename];
        if(!entry)throw new Error('This PDF character map is unavailable.');
        return data.slice(entry[0],entry[0]+entry[1]);
      }
      const folder={standardFontDataUrl:'standard_fonts',wasmUrl:'wasm'}[kind];
      if(!folder)throw new Error('Unsupported PDF resource.');
      return getBytes('assets/vendor/pdfjs/'+folder+'/'+filename);
    }
  }
  return {url,ready,pdfOptions:()=>({BinaryDataFactory,useWorkerFetch:false})};
})();
