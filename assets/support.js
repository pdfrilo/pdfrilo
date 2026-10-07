
const PDFRILO_SUPPORT_ENDPOINT = 'https://api.web3forms.com/submit';
const PDFRILO_SUPPORT_ACCESS_KEY = '10797101-252d-44bb-b269-9c7e881a33df';
for (const el of document.querySelectorAll('.year')) el.textContent = new Date().getFullYear();
const form = document.querySelector('#supportForm');
const suggestionDialog = document.querySelector('#suggestionDialog');
if (form && suggestionDialog) {
  const originalParent=form.parentNode,originalNext=form.nextSibling;
  for (const button of document.querySelectorAll('[data-open-suggestion]')) button.addEventListener('click',()=>{
    if(suggestionDialog.open)return;
    document.querySelector('#suggestionFormSlot').appendChild(form);
    suggestionDialog.showModal();form.querySelector('textarea[name="problem"]').focus();
  });
  document.querySelector('#closeSuggestion').addEventListener('click',()=>suggestionDialog.close());
  suggestionDialog.addEventListener('close',()=>originalParent.insertBefore(form,originalNext));
}
if (form) {
  const status = document.querySelector('#reportStatus'), report = document.querySelector('#preparedReport'), copy = document.querySelector('#copyReport');
  let sending = false;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (sending || !form.reportValidity()) return;
    const f = new FormData(form), data = Object.fromEntries(f.entries());
    if (f.get('botcheck')) return;
    if (!String(data.problem || '').trim()) {
      status.textContent = 'Please write your suggestion or problem.';
      form.querySelector('textarea[name="problem"]').focus();
      return;
    }
    const body = 'PDFRilo suggestion / problem\n\nName: '+(data.name||'Not provided')+'\nEmail: '+(data.email||'Not provided')+'\nBrowser / device: '+(data.device||'Not provided')+'\n\nMessage:\n'+data.problem;
    const payload = {
      access_key: PDFRILO_SUPPORT_ACCESS_KEY,
      subject: 'PDFRilo - Help Us Improve',
      from_name: 'PDFRilo Website',
      name: data.name || 'Not provided',
      message: data.problem,
      device: data.device || 'Not provided',
      botcheck: false
    };
    if (data.email) payload.email = data.email;
    const button = form.querySelector('button[type="submit"]');
    const label = button.textContent;
    sending = true; button.disabled = true; button.textContent = 'Sending...';
    status.textContent = 'Sending your suggestion...';
    report.classList.add('hidden'); copy.classList.add('hidden');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const result = await fetch(PDFRILO_SUPPORT_ENDPOINT, {
        method: 'POST', headers: {'Content-Type':'application/json', 'Accept':'application/json'},
        body: JSON.stringify(payload), signal: controller.signal
      });
      const response = await result.json();
      if (!result.ok || response.success !== true) throw new Error('Submission failed');
      status.textContent = 'Thank you! Your suggestion has been sent.';
      form.reset(); report.value = '';
    } catch {
      status.textContent = 'We could not confirm sending. Your message is still here. You can try again or copy it below.';
      report.value = body; report.classList.remove('hidden'); copy.classList.remove('hidden');
    } finally {
      clearTimeout(timeout); sending = false; button.disabled = false; button.textContent = label;
    }
  });
  copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(report.value);status.textContent='Report copied.';}catch{report.focus();report.select();status.textContent='Select and copy the report above.';}});
}
