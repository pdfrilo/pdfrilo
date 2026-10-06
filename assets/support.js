
// Set endpoint only after connecting and testing a real support service.
const PDFRILO_SUPPORT_ENDPOINT = '';
for (const el of document.querySelectorAll('.year')) el.textContent = new Date().getFullYear();
const form = document.querySelector('#supportForm');
if (form) {
  const status = document.querySelector('#reportStatus'), report = document.querySelector('#preparedReport'), copy = document.querySelector('#copyReport');
  form.addEventListener('submit', async e => {
    e.preventDefault();if (!form.reportValidity()) return;
    const f=new FormData(form), data=Object.fromEntries(f.entries());
    const body = 'PDFRilo problem report\n\nName: '+(data.name||'Not provided')+'\nEmail: '+(data.email||'Not provided')+'\nBrowser / device: '+(data.device||'Not provided')+'\n\nProblem:\n'+data.problem;
    if (!PDFRILO_SUPPORT_ENDPOINT) {report.value=body;report.classList.remove('hidden');copy.classList.remove('hidden');status.textContent='Report prepared on your device. It has not been sent.';return;}
    const button=form.querySelector('button[type="submit"]');button.disabled=true;
    try {const result=await fetch(PDFRILO_SUPPORT_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});if(!result.ok)throw new Error();status.textContent='Your report was submitted.';}
    catch {status.textContent='The report could not be sent. Please try again later.';}
    finally {button.disabled=false;}
  });
  copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(report.value);status.textContent='Report copied. It has not been sent.';}catch{report.focus();report.select();status.textContent='Select and copy the report above. It has not been sent.';}});
}

