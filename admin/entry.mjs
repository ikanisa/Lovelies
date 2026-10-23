export function previewAllowed(location) {
  const url=new URL(location.href);
  return ['localhost','127.0.0.1','[::1]'].includes(url.hostname) && url.searchParams.get('preview')==='1';
}

export async function boot({location=globalThis.location,document=globalThis.document}={}) {
  if(previewAllowed(location)) {
    document.querySelector('.preview-pill').textContent='Local preview';
    document.querySelector('.operator').innerHTML='<button class="operator-identity" data-user="Account 1001" aria-label="View current preview operator Alex Morgan"><span class="operator-avatar" aria-hidden="true">AM</span><span>Alex Morgan<small>Sample operator</small></span></button><button class="icon-button" data-action="reset" aria-label="Reset sample workspace"><span>↺</span></button>';
    document.querySelector('[data-action="about"]').textContent='About this preview';
    document.querySelector('.workspace-footer').firstElementChild.textContent='Sample workspace · No live account changes';
    await import('./app.js');
  } else {
    const {startWorkspace}=await import('./live-app.mjs');
    await startWorkspace();
  }
}

if(typeof document!=='undefined')boot().catch(()=>{
  document.querySelector('#main').textContent='The protected workspace could not start. Refresh to retry.';
});
