#!/usr/bin/env node
// Opt-in real-DOM check. The production entry is replaced only inside this
// browser context with the existing startWorkspace injection seam. It uses
// synthetic records, blocks non-loopback page requests and does not test login.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const target=new URL(process.argv[2]??'http://127.0.0.1:8765/admin/');
if(target.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||target.username||target.password||target.search||target.hash||!['/','/admin/'].includes(target.pathname))throw new Error('Pass an exact loopback HTTP preview origin or /admin/ URL');
target.pathname='/admin/';
const inputPaths=['admin/check-browser-navigation.mjs','admin/index.html','admin/styles.css','admin/workspace.css','admin/collection-views.css','admin/detail-views.css','admin/live-workspace.css','admin/live-app.mjs','admin/live-queues.mjs','admin/live-collections.mjs','admin/review-drafts.mjs','admin/draft-store.mjs','admin/operator-session.mjs','admin/audience.mjs','admin/runtime-config.mjs','clients/backend/contracts.mjs','clients/backend/operator-capabilities.mjs','clients/backend/face-contracts.mjs','clients/backend/audience-contracts.mjs'];
const hashes=async()=>Object.fromEntries(await Promise.all(inputPaths.map(async path=>[path,createHash('sha256').update(await readFile(resolve(root,path))).digest('hex')])));
const inputs=await hashes(),checks=[],blockedOrigins=[],pageErrors=[];
const report={protocol:'lovelies-admin-browser-navigation-v1',status:'incomplete',started_at:new Date().toISOString(),inputs,checks,blocked_origins:blockedOrigins,page_errors:pageErrors,scope:{synthetic_session:true,production_authentication:false,service_workers:'blocked',native_installation:false,spoken_screen_reader:false}};
let browser;

const entry=`
import {startWorkspace} from './live-app.mjs';
import {ReviewDrafts} from './review-drafts.mjs';
import {ReviewDraftStore} from './draft-store.mjs';
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const fixture=window.__loveliesBrowserFixture={ready:false,calls:[],logoutCalls:0,holdRead:false,releaseRead:null,installCalls:0};
const session=fixture.session={base:location.origin+'/synthetic-admin-api',operator:{user_id:id(9),roles:['admin']},credentials:{synthetic:true},challenge:null,captures:[],audienceReview:null,state:{reference:{},pendingAction:null},
 async restore(){return {registered:true,pending:false};},
 cancelCapture(){this.challenge=null;this.captures=[];this.audienceReview=null;},
 async request(path){fixture.calls.push(path);if(path!=='/admin/metrics')throw Error('Unexpected synthetic route');if(fixture.holdRead)return new Promise(resolve=>fixture.releaseRead=resolve);return {accounts:4,uploads:8,active_grants:3,open_support:2,open_reports:1};},
 async logout(){fixture.logoutCalls++;this.credentials=null;this.operator=null;}
};
fixture.drafts=new ReviewDrafts({storage:new ReviewDraftStore(session.base,{indexedDB,localStorage})});
fixture.scope={accountId:id(9),recordId:id(1),form:'live-review-form',target:'support',version:'revision:1'};
fixture.app=await startWorkspace({session,drafts:fixture.drafts});await fixture.app.refresh();fixture.ready=true;
`;

try{
 const {chromium}=await import(process.env.LOVELIES_PLAYWRIGHT_MODULE||'playwright');
 browser=await chromium.launch({headless:true,...(process.env.LOVELIES_CHROMIUM_EXECUTABLE?{executablePath:process.env.LOVELIES_CHROMIUM_EXECUTABLE}:{})});
 report.browser=await browser.version();
 for(const width of [320,760,1280]){
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin!==target.origin){blockedOrigins.push(url.origin);await route.abort('blockedbyclient');return;}
   if(url.pathname==='/admin/entry.mjs'){await route.fulfill({contentType:'text/javascript',body:entry});return;}
   await route.continue();
  });
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>pageErrors.push(error.message));
  await page.goto(target.href,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.__loveliesBrowserFixture?.ready===true);
  const menu=page.locator('#navigation-dialog'),main=page.locator('#main'),opener=page.getByRole('button',{name:'Open navigation',exact:true});
  const mobile=width<=760;
  if(mobile){assert(await opener.isVisible());await opener.click();assert(await menu.isVisible());}
  else assert.equal(await opener.isVisible(),false);
  const utilities=mobile?menu:page.locator('.sidebar');
  const logout=utilities.getByRole('button',{name:'Sign out and clear private workspace',exact:true});
  assert(await logout.isVisible());assert(await logout.isEnabled());
  assert(await utilities.getByRole('button',{name:'Workspace help',exact:true}).isVisible());
  assert.equal(await utilities.getByRole('button',{name:'Install app',exact:true}).isVisible(),false);
  const bounds=await logout.boundingBox();assert(bounds&&bounds.x>=0&&bounds.x+bounds.width<=width+1&&bounds.height>=44);
  checks.push(`${width}px: existing utilities are reachable; sign-out is enabled; installation is hidden without an offer`);
  if(mobile){
   await page.keyboard.press('Escape');assert.equal(await menu.isVisible(),false);
   assert(await opener.evaluate(element=>element===document.activeElement));await opener.click();
   checks.push(`${width}px: native Escape closes navigation and restores opener focus`);
  }
  await utilities.getByRole('button',{name:'Workspace help',exact:true}).click();
  assert.equal(await menu.isVisible(),false);assert((await main.innerText()).includes('Operator roles require independent provisioning.'));
  assert(await main.evaluate(element=>element===document.activeElement));
  checks.push(`${width}px: help closes navigation and focuses the visible outcome`);
  await page.evaluate(()=>{
   const event=new Event('beforeinstallprompt',{cancelable:true});
   event.prompt=()=>{window.__loveliesBrowserFixture.installCalls++;return Promise.resolve();};window.dispatchEvent(event);
  });
  if(mobile)await opener.click();
  const install=utilities.getByRole('button',{name:'Install app',exact:true});assert(await install.isVisible());await install.click();
  assert.equal(await menu.isVisible(),false);
  assert.equal(await page.evaluate(()=>window.__loveliesBrowserFixture.installCalls),1);
  assert.equal(await page.locator('#install-button').isVisible(),false);assert.equal(await page.locator('#mobile-install-button').isVisible(),false);
  checks.push(`${width}px: synthetic installation offer reaches the existing handler once and hides both controls`);
  await page.evaluate(async()=>{
   const fixture=window.__loveliesBrowserFixture;await fixture.drafts.save(fixture.scope,{reason:'Synthetic private draft'});fixture.holdRead=true;
   fixture.pendingRead=fixture.app.refresh();
  });
  await page.waitForFunction(()=>typeof window.__loveliesBrowserFixture.releaseRead==='function');
  if(mobile)await opener.click();
  await logout.click();assert.equal(await menu.isVisible(),false);assert(await main.evaluate(element=>element===document.activeElement));
  assert(await main.getByRole('button',{name:'Verify my face',exact:true}).isVisible());
  const cleared=await page.evaluate(async()=>{
   const fixture=window.__loveliesBrowserFixture;
   fixture.releaseRead({accounts:999});await fixture.pendingRead;await fixture.drafts.pending;
   return {logoutCalls:fixture.logoutCalls,operator:fixture.session.operator,credentials:fixture.session.credentials,draft:await fixture.drafts.restore(fixture.scope),calls:fixture.calls};
  });
  assert.equal(cleared.logoutCalls,1);assert.equal(cleared.operator,null);assert.equal(cleared.credentials,null);assert.equal(cleared.draft,null);
  assert.equal((await main.innerText()).includes('999'),false);assert.deepEqual(cleared.calls,['/admin/metrics','/admin/metrics']);
  checks.push(`${width}px: sign-out closes navigation, clears browser-backed drafts and fences a late read`);
  if(mobile)await opener.click();
  assert.equal(await logout.isEnabled(),false);
  await utilities.getByRole('button',{name:'Workspace help',exact:true}).click();
  assert.equal(await menu.isVisible(),false);assert((await main.innerText()).includes('Operator roles require independent provisioning.'));
  checks.push(`${width}px: public help remains visible and sign-out stays disabled after authority clears`);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(overflow,false,`${width}px document overflow`);
  await context.close();
 }
 assert.deepEqual(blockedOrigins,[],'Application attempted non-loopback traffic');assert.deepEqual(pageErrors,[],'Browser script error');
 assert.deepEqual(await hashes(),inputs,'Browser inputs changed during verification');report.status='passed';
}catch(error){report.status='failed';report.error=error.stack??String(error);process.exitCode=1;}
finally{
 await browser?.close();report.finished_at=new Date().toISOString();
 if(process.argv[3]){const output=resolve(process.argv[3]);await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});}
 console.log(JSON.stringify(report,null,2));
}
