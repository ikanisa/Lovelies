/* Lovelies screenshot review. All interactions below are local front-end state. */
(() => {
  'use strict';
  const ASSETS = '../shared/assets/';
  const GRID_ASSETS = '../shared/reference-grids/assets/';
  const ART_ASSETS = '../shared/reference-art/';
  const REFERENCES = '../Lovelies-48-Screen-PNGs/screens/';
  const titles = ['Splash','Introduction and how it works','Sign in and join','Photo access prompt','Photo access options','Face enrollment','Face quality retry','Processing','Setup complete','Home gallery','New matches','Photo viewer','All photos','Favorites and saved','Search','Filters','Activity inbox','Notifications','Upload entry','Upload source picker','Select upload photos','Review upload','Upload progress','Upload complete','Match results summary','Matched photos gallery','Photo to people','Person to photos','Select photos to share','Deselect photos','Select people to share with','Deselect people','Review and share','Sharing progress','Shared history','Report incorrect match','Profile overview','Face management','Manage allowed recipients','Privacy and sharing','Photo access settings','Notification settings','Storage','Data export','Help center','Account security and devices','No matches','Offline and error'];
  let catalog = titles.map((title,i) => ({id:i+1,title,group:i<9?'Setup':i<18?'Library':i<24?'Upload':i<36?'Sharing':'Profile',width:240,height:390}));
  let referenceLayouts={};
  let homeTiles = [
    [1,.004329,.023810,.259740,.257937],[2,.285714,.011905,.199134,.273810],[3,.510823,.007937,.207792,.166667],[4,.748918,.007937,.233766,.230159],
    [5,.008658,.305556,.151515,.257937],[6,.190476,.301587,.294372,.226190],[7,.510823,.194444,.207792,.269841],[8,.748918,.265873,.233766,.230159],
    [9,.008658,.595238,.194805,.194444],[10,.229437,.555556,.255411,.158730],[11,.510823,.484127,.207792,.218254],[12,.748918,.527778,.233766,.269841],
    [13,.008658,.821429,.194805,.166667],[14,.229437,.738095,.255411,.250000],[15,.510823,.726190,.207792,.261905],[16,.748918,.825397,.233766,.162698]
  ].map(([id,x,y,width,height])=>({id,asset:`home${String(id).padStart(2,'0')}.jpg`,x,y,width,height}));
  const app = document.getElementById('app');
  const device = document.getElementById('device');
  const dialog = document.getElementById('action-dialog');
  const defaultPhotos = [1,4,6,8,9,10,11,12];
  const uploadDefault = [1,3,4,6,10,11,12,14,15,16,17,18];
  const cloudSources = [
    {name:'Google Photos',symbol:'photo'},
    {name:'Google Drive',symbol:'folder'},
    {name:'iCloud Photos',symbol:'cloud',platform:'ios'},
    {name:'Dropbox',symbol:'folder'},
    {name:'OneDrive',symbol:'cloud'}
  ];
  const photoMetadata = [
    ['Sunset by the coast','sunsets travel coast friends'],['Coastal town','travel places town'],['A happy dog','friends pets dog'],['Cathedral','travel places town'],['Friends on holiday','friends people travel'],['Swimming at the coast','travel coast water'],['Mountain village','travel mountains places'],['Afternoon with friends','friends people travel'],['Garden walk','pets dog friends'],['Summer adventure','friends travel people'],['Golden hour','sunsets friends people'],['Night out','friends people party'],['Italian coastline','travel town places'],['Tower at sunset','sunsets places town'],['Old town cathedral','travel places town'],['A day by the lake','travel friends water'],['Summer sunshine','friends people'],['Blue skies','friends people travel']
  ].map(([title,tags],i)=>({id:i+1,title,tags}));
  const people = [
    {id:1,name:'Sophie',full:'Sophie Chen',count:6}, {id:2,name:'Mark',full:'Marcus Bell',count:4}, {id:3,name:'Emma',full:'Emma Wilson',count:3}, {id:4,name:'James',full:'James Miller',count:3}, {id:5,name:'Olivia',full:'Olivia Brooks',count:2}, {id:6,name:'Daniel',full:'Daniel Kim',count:2}, {id:7,name:'Maya',full:'Maya Patel',count:1}, {id:8,name:'Lucas',full:'Lucas Rivera',count:1}
  ];
  const matchedRecipients = people.map(person=>({id:person.id,name:person.full,avatarId:person.id}));
  const recipients = [...matchedRecipients,...[[13,'Sam Carter',5],[14,'Jamie Lee',6],[15,'Robin Jones',7]].map(([id,name,avatarId])=>({id,name,avatarId}))];
  const initialState = () => ({
    screen:10, platform:'ios', compare:false, activePhoto:1, activePhotoAsset:null, activePerson:1,
    selectedPhotos:new Set(defaultPhotos), selectedPeople:new Set([1,2,3,5,7]), uploadPhotos:new Set(uploadDefault), favorites:new Set([2,3,5,10,17]),
    newMatchSelections:new Set([1,2,4,5,6]), searchSelections:new Set([4,6,7]), referenceSaved:new Set([2,3,4,5]), selectionAssets:{}, reviewReferenceFixture:false,
    photoTab:'All', activityTab:'All', notificationTab:'All', profileTab:'photos', recipientTab:'Allowed', access:'all', pose:0, faceVariant:1,
    search:'', helpSearch:'', filterCategory:'People', filterPeople:new Set([1]), mediaType:'Photos', dateRange:'Any date', location:'Any location', filtersApplied:false,
    caption:'', album:'Travels 2024', visibility:'Matched people only', uploadSource:'Device', uploadProgress:78, sharingProgress:2,
    privacy:{saving:true,location:false,suggestions:true,analytics:false}, notifications:{matches:true,messages:true,mentions:true,tips:true,reminders:false,marketing:false}, findable:'Anyone', email:'jasmine@lovelies.app', phone:'+1 (555) 123-4567',
    reportReason:'This isn’t me', name:'Jasmine', bio:'Here for the good photos\nand great company ✨', blocked:new Set([13,14,15]), cacheCleared:false, exported:false, reportSubmitted:false, sharedLocally:false, signedOut:false, devices:3, twoFactor:false,
    history:[], trail:[], uploadCompleted:false
  });
  let state = initialState();
  const isAllowedRecipient = id => matchedRecipients.some(person=>person.id===id)&&!state.blocked.has(id);
  const shareablePeople = () => people.filter(person=>isAllowedRecipient(person.id));
  const managedRecipients = tab => tab==='Blocked'?recipients.filter(person=>state.blocked.has(person.id)):matchedRecipients.filter(person=>!state.blocked.has(person.id));
  function reconcileShareRecipients(){
    const eligible=new Set(shareablePeople().map(person=>person.id));
    for(const id of state.selectedPeople)if(!eligible.has(id))state.selectedPeople.delete(id);
  }
  function toggleSharePerson(id){
    if(!shareablePeople().some(person=>person.id===id))return;
    state.selectedPeople.has(id)?state.selectedPeople.delete(id):state.selectedPeople.add(id);
  }
  let toastTimer;
  let searchAnnouncementTimer;
  let progressTimer;
  let dialogReturn;
  let historyPosition=0;
  const routeViews = new Map();
  const routeParents = {2:1,3:2,4:3,5:4,6:5,7:6,8:6,9:10,11:10,12:10,13:10,14:10,15:10,16:15,17:10,18:10,19:10,20:19,21:20,22:21,23:22,24:13,25:10,26:25,27:12,28:27,29:26,30:29,31:29,32:31,33:31,34:33,35:10,36:28,37:10,38:37,39:37,40:37,41:37,42:37,43:37,44:37,45:37,46:37,47:10,48:10};
  const describeFocus = el => el ? {id:el.id, data:{...el.dataset}, value:el.value, start:el.selectionStart, end:el.selectionEnd} : null;
  function findFocus(description) {
    if(!description)return null;
    if(description.id)return document.getElementById(description.id);
    return [...app.querySelectorAll('[data-action],[data-setting],[data-input]')].find(el=>Object.entries(description.data).every(([key,value])=>el.dataset[key]===value)&&(!description.data.setting||el.value===description.value));
  }
  function saveRouteView() {
    if(device.dataset.screenId!==String(state.screen))return;
    routeViews.set(state.screen,{focus:app.contains(document.activeElement)?describeFocus(document.activeElement):null,scroll:[app,...app.querySelectorAll('.screen,.gallery-wrap,.scroll-content,.people-list')].map(el=>el.scrollTop)});
  }
  function announce(message) {
    const status=document.getElementById('screen-status');
    if(status)status.textContent=message;
  }
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const pad = number => String(number).padStart(2,'0');
  const photoURL = id => `${ASSETS}photo${pad(id)}.jpg`;
  const activePhotoURL = () => state.activePhotoAsset?(state.activePhotoAsset.startsWith('../')?state.activePhotoAsset:`${ASSETS}${state.activePhotoAsset}`):photoURL(state.activePhoto);
  const personURL = id => `${ASSETS}person${pad(id)}.jpg`;
  const paths = {
    cloud:'<path d="M7 19a5 5 0 0 1-1-10 6 6 0 0 1 12-1 5.5 5.5 0 0 1 0 11H7z"/>', folder:'<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6zM3 10h18"/>',
    back:'<path d="m14 5-7 7 7 7"/>', next:'<path d="M5 12h14m-6-6 6 6-6 6"/>', close:'<path d="m6 6 12 12M6 18 18 6"/>', check:'<path d="m5 12 4 4L19 6"/>',
    home:'<path d="m3 10 9-7 9 7v10h-6v-7H9v7H3z"/>', people:'<circle cx="9" cy="8" r="3"/><path d="M3 20v-3a6 6 0 0 1 12 0v3H3m13-13a3 3 0 0 1 0 6m1 2c3 0 4 2 4 5"/>', person:'<circle cx="12" cy="7" r="3.3"/><path d="M5 20v-2a7 7 0 0 1 14 0v2z"/>', photo:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.6"/><path d="m4 18 6-7 4 4 3-4 4 6"/>', heart:'<path d="M12 21 3.5 12.6C-2 6.5 6.4.6 12 6.8 17.6.6 26 6.5 20.5 12.6z"/>', share:'<path d="M12 15V2m-5 5 5-5 5 5M6 10H3v12h18V10h-3"/>', search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>', bell:'<path d="M5 16h14l-2-4V8a5 5 0 0 0-10 0v4zM9 19a3 3 0 0 0 6 0"/>', more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>', grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>', filter:'<path d="M3 6h8m6 0h4M3 12h2m6 0h10M3 18h12m6 0h0"/><circle cx="14" cy="6" r="3"/><circle cx="8" cy="12" r="3"/><circle cx="18" cy="18" r="3"/>', pin:'<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0z"/><circle cx="12" cy="10" r="2"/>', calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 2v6m10-6v6M3 10h18m-14 4h2m3 0h2m3 0h1M7 17h2m3 0h2"/>', video:'<rect x="2" y="6" width="14" height="12" rx="3"/><path d="m16 10 6-4v12l-6-4"/>', live:'<circle cx="12" cy="12" r="3"/><path d="M5 5a10 10 0 0 0 0 14m14-14a10 10 0 0 1 0 14M8 7a6 6 0 0 0 0 10m8-10a6 6 0 0 1 0 10"/>', phone:'<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M10 19h4"/>', albums:'<rect x="6" y="5" width="14" height="16" rx="2"/><path d="M17 5V2H3v16h3M9 13l3-3 5 6m-8-7h1"/>', file:'<path d="M5 2h9l5 5v15H5zM14 2v6h5M8 13h8m-8 4h8"/>', camera:'<path d="M3 7h4l2-3h6l2 3h4v14H3z"/><circle cx="12" cy="13" r="4"/>', lock:'<rect x="4" y="10" width="16" height="12" rx="2"/><path d="M7 10V6a5 5 0 0 1 10 0v4M12 15v3"/>', shield:'<path d="m12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6z"/>', shieldCheck:'<path d="m12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6zM7 12l3 3 7-7"/>', message:'<path d="M3 3h18v14H9l-6 5zM7 8h10m-10 4h7"/>', mention:'<circle cx="12" cy="12" r="9"/><path d="M16 9v7c3 1 5-1 5-4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0"/>', bulb:'<path d="M7 13a7 7 0 1 1 10 0l-2 3H9zM9 19h6m-5 3h4M12 1v-1"/>', star:'<path d="m12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"/>', link:'<path d="M10 7 8 5a6 6 0 0 0-8 8l5 5a6 6 0 0 0 9-1m0-10 2-2a6 6 0 0 1 8 8l-5 5a6 6 0 0 1-9-1M8 16l8-8"/>', personAdd:'<circle cx="9" cy="7" r="3"/><path d="M2 20v-2a7 7 0 0 1 14 0v2H2M19 6v8m-4-4h8"/>', edit:'<path d="m4 16 12-12 4 4L8 20H4zM14 6l4 4"/>', analytics:'<path d="M4 20V12m5 8V7m5 13V3m5 17V9"/>', mail:'<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 5 10 9L22 5"/>', laptop:'<path d="M4 4h16v13H4zM1 21h22l-3-4H4z"/>', logout:'<path d="M9 3H3v18h6M9 12h13m-5-5 5 5-5 5"/>', trash:'<path d="M3 5h18M9 5V2h6v3M5 5l1 17h12l1-17M10 9v9m4-9v9"/>', help:'<circle cx="12" cy="12" r="10"/><path d="M8 8a4 4 0 0 1 8 0c0 3-4 3-4 6m0 3v1"/>', settings:'<path d="m9 2-1 3-3 1-3 3 2 3-1 3 3 3 3-1 3 3 3-2 3 1 3-3-1-3 2-3-3-3-3 1-3-3z"/><circle cx="12" cy="12" r="3"/>', cloudOff:'<path d="M5 18a5 5 0 0 1-1-10 8 8 0 0 1 15-1 6 6 0 0 1 2 11H11M17 4 5 22"/>', downloadFile:'<path d="M5 2h9l5 5v15H5zM14 2v6h5M12 10v8m-4-4 4 4 4-4"/>', send:'<path d="m2 10 20-8-8 20-4-8-8-4zM10 14 22 2"/>', face:'<circle cx="12" cy="8" r="5"/><path d="M3 22v-2a9 9 0 0 1 18 0v2zM9 8h0m6 0h0m-5 3a3 3 0 0 0 4 0"/>', bag:'<rect x="3" y="7" width="18" height="15" rx="2"/><path d="M8 8V5a4 4 0 0 1 8 0v3M7 12h0m10 0h0"/>', megaphone:'<path d="m3 9 13-5v16L3 15zM6 16l2 6h4l-2-5M19 7l3-1m-3 7h3m-3 5 3 1"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]||paths.photo}</svg>`;
  const button = (label, action, extra='', cls='primary', symbol='') => `<button type="button" class="${cls}" data-action="${action}" ${extra}>${symbol?icon(symbol):''}${esc(label)}</button>`;
  const iconButton = (name, action, label, extra='', cls='') => `<button type="button" class="icon-button ${cls}" data-action="${action}" aria-label="${esc(label)}" ${extra}>${icon(name)}</button>`;
  const header = (title, {back=10,right='',subtitle='',left='',titleLeft=false}={}) => `<header class="top-header">${left||iconButton('back','back','Back',`data-target="${back}"`)}<div class="header-title"><h2>${esc(title)}</h2>${subtitle?`<small>${esc(subtitle)}</small>`:''}</div>${right||'<span aria-hidden="true"></span>'}</header>`;
  const primary = (label,action,extra='',symbol='') => button(label,action,extra,'primary',symbol);
  const avatar = (id,cls='',alt='') => `<img class="avatar ${cls}" src="${personURL(id)}" alt="${esc(alt)}" loading="eager">`;
  const personBubble = (id,{count='',label=false,action='person-view'}={}) => `<button type="button" class="person-bubble" data-action="${action}" data-id="${id}" aria-label="${esc(people[id-1]?.name||'Person')}${count?`, ${count} matches`:''}">${avatar(id,'pink-ring')}${count!==''?`<span class="bubble-count">${esc(count)}</span>`:''}${label?`<span class="person-name">${esc(people[id-1]?.name)}</span>`:''}</button>`;
  const photo = (id,{action='view-photo',selected=false,selectable=false,favorite=false,size='',badge=false,dim=false}={}) => {
    const metadata = photoMetadata[id-1]||photoMetadata[0];
    return `<button type="button" class="photo ${size} ${selected?'selected':''} ${favorite?'favorite':''} ${dim?'deselected':''}" data-action="${action}" data-id="${id}" aria-label="${selectable?(selected?'Deselect ':'Select '):favorite?'Open favorite ':''}${esc(metadata.title)}" ${selectable?`aria-pressed="${selected}"`:''}><img src="${photoURL(id)}" alt="" loading="eager">${selectable||favorite?`<span class="photo-check">${selected?icon('check'):favorite?icon('heart'):''}</span>`:''}${badge?`<span class="photo-badge">${icon('people')}</span>`:''}</button>`;
  };
  const gallery = (ids,{columns=3,selected=null,favorites=false,badges=false,action='view-photo',dim=false}={}) => `<div class="masonry ${columns===4?'four':''}">${ids.map((id,i)=>photo(id,{action,selected:selected?.has(id),selectable:!!selected,favorite:favorites&&state.favorites.has(id),size:i%5===1?'wide':i%4===0?'tall':'',badge:badges&&i%4===0,dim:dim&&selected&&!selected.has(id)})).join('')}</div>`;
  const bottomNav = (current='home',profile=false) => `<nav class="bottom-nav" aria-label="Main navigation">${(profile?[['home',10,'Home'],['search',15,'Search'],['heart',14,'Favorites'],['person',37,'Profile']]:[['home',10,'Home'],['people',11,'Matches'],['photo',19,'Add photos'],['heart',14,'Favorites'],['person',37,'Profile']]).map(([name,target,label])=>`<button type="button" data-action="go" data-target="${target}" data-icon="${name}" aria-label="${label}" ${current===name?'aria-current="page"':''}>${icon(name)}</button>`).join('')}</nav>`;
  const chips = (names,active,action) => `<div class="chips">${names.map(name=>button(name,action,`data-value="${esc(name)}" aria-pressed="${active===name}"`,'chip')).join('')}</div>`;
  const row = (symbol,title,{subtitle='',value='',action='info',extra='',toggle=null}={}) => `<${toggle?'label':'button'} ${toggle?'':`type="button" data-action="${action}"`} class="list-row" ${extra}><span class="row-icon">${icon(symbol)}</span><span class="row-main"><strong>${esc(title)}</strong>${subtitle?`<small>${esc(subtitle)}</small>`:''}</span>${value?`<span class="row-value">${esc(value)}</span>`:''}${toggle?`<input type="checkbox" class="toggle" data-setting="${toggle.group}" data-key="${toggle.key}" aria-label="${esc(title)}" ${state[toggle.group][toggle.key]?'checked':''}>`:'<span class="chevron" aria-hidden="true">›</span>'}</${toggle?'label':'button'}>`;
  const uploadSourceContext = () => cloudSources.some(source=>source.name===state.uploadSource)?`${state.uploadSource} · sample photos`:({Device:'This device',Albums:`Albums · ${state.album}`,Files:'Files',Camera:'Camera'}[state.uploadSource]||state.uploadSource);
  function sourcePicker(){
    const cloudRow = source => row(source.symbol,source.name,{subtitle:source.symbol==='photo'||source.name==='iCloud Photos'?'Sample photo library':'',action:'upload-source',extra:`data-value="${source.name}" aria-label="${source.name}, preview sample photos"`});
    const available=cloudSources.filter(source=>!source.platform||source.platform===state.platform);
    const libraries=available.filter(source=>source.name==='Google Photos'||source.name==='iCloud Photos');
    const storage=available.filter(source=>!libraries.includes(source));
    return `<section class="screen source-picker">${header('Choose Source',{left:iconButton('close','back','Close source picker','data-target="19"')})}<div class="scroll-content source-list" role="region" aria-label="Photo sources"><section class="source-group" aria-labelledby="photo-libraries"><h3 id="photo-libraries">Photo libraries</h3><div class="list-group">${row('phone','From This Device',{subtitle:'Browse your photos',action:'upload-source',extra:'data-value="Device"'})}${libraries.map(cloudRow).join('')}</div></section><section class="source-group" aria-labelledby="cloud-storage"><div class="source-group-heading"><h3 id="cloud-storage">Cloud storage</h3><small>Sample photos</small></div><div class="list-group cloud-source-list">${storage.map(cloudRow).join('')}</div></section><section class="source-group" aria-labelledby="more-sources"><h3 id="more-sources">More ways</h3><div class="list-group">${[['albums','From Albums','Choose specific albums','Albums'],['file','From Files','Import from your files','Files'],['camera','Take a Photo','Use your camera','Camera']].map(([sym,title,subtitle,value])=>row(sym,title,{subtitle,action:'upload-source',extra:`data-value="${value}"`})).join('')}</div></section></div></section>`;
  }
  const heartArt = () => `<img class="photo-heart" src="${ASSETS}photo-heart.png" alt="Photos with a pink heart">`;
  const heroRing = (symbol='check',cls='') => `<div class="hero-ring ${cls}"><span class="sparkles"></span>${icon(symbol)}</div>`;
  const sourceArt = (asset,extra='') => `<img class="source-art ${extra}" src="${ART_ASSETS}${asset}" alt="" aria-hidden="true">`;
  const catButtons = (active='',action='category') => `<div class="category-grid">${[['People','people'],['Places','pin'],['Dates','calendar'],['Favorites','heart']].map(([label,sym])=>`<button type="button" class="category-button" data-action="${action}" data-value="${label}" aria-pressed="${active===label}">${icon(sym)}<span>${label}</span></button>`).join('')}</div>`;
  const peopleRows = selection => shareablePeople().map(person=>`<button type="button" class="person-select-row ${selection.has(person.id)?'selected-row':''}" data-action="select-person" data-id="${person.id}" aria-pressed="${selection.has(person.id)}">${avatar(person.id,'pink-ring')}<span class="row-main"><strong>${person.name}</strong><small>Matched in ${person.count} ${person.count===1?'photo':'photos'}</small></span><span class="visual-check">${selection.has(person.id)?'✓':''}</span></button>`).join('')||`<div class="empty-search"><strong>No people available</strong><p>Manage your blocked people to make someone available for a future share.</p>${button('Manage People','go','data-target="39"','text-button')}</div>`;
  function canonicalAssets(route){const result={};for(const tile of referenceLayouts[String(route)]?.tiles||[])if(!result[tile.id])result[tile.id]=GRID_ASSETS+tile.asset;return result;}
  function selectedFixture(route){return new Set((referenceLayouts[String(route)]?.tiles||[]).filter(tile=>tile.selected).map(tile=>tile.id));}
  function referenceGrid(route,{selection=null,mode='',filterIds=null,overrideAssets=null}={}){
    const layout=referenceLayouts[String(route)];
    if(!layout)return gallery(route===21?Array.from({length:18},(_,i)=>i+1):Array.from({length:12},(_,i)=>i+1),{selected:selection,action:selection?'select-photo':'view-photo'});
    const tiles=filterIds?layout.tiles.filter(tile=>filterIds.has(tile.id)):layout.tiles;
    const action=mode==='upload'?'select-upload':mode==='selection'?'select-photo':mode==='face'?'face-variant':'view-photo';
    return `<div role="group" class="reference-grid reference-grid-${route} ${layout.dimmed?'dim-source-grid':''}" aria-label="${route===38?'Your enrolled selfies':'Photo gallery'}">${tiles.map((tile,ordinal)=>{
      const asset=overrideAssets?.[tile.id]||GRID_ASSETS+tile.asset;
      const selected=mode==='face'?state.faceVariant===tile.id:selection?selection.has(tile.id):Boolean(tile.selected);
      const bounds=tile.controlBounds;
      const badgeStyle=bounds?`--control-left:${bounds[0]*100}%;--control-top:${bounds[1]*100}%;--control-width:${bounds[2]*100}%;--control-height:${bounds[3]*100}%;left:${bounds[0]*100}%;top:${bounds[1]*100}%;width:${bounds[2]*100}%;height:${bounds[3]*100}%;`:'right:5%;top:5%;width:28%;aspect-ratio:1;';
      const showControl=tile.badgeKind&&(mode!=='upload'||tile.controlBaked||selected);
      const badgeAction=mode==='selection'?'select-photo':mode==='upload'?'select-upload':mode==='favorites'?'reference-favorite':mode==='matches'?'select-new-match':mode==='search'?'select-search-result':'view-photo';
      const favorite=tile.badgeKind==='favorite';
      const label=mode==='face'?`Enrolled selfie ${tile.id}`:`Memory ${tile.id}`;
      return `<div class="ref-photo-cell ${tile.latent?'latent-cell':''} ${selected?'selected-cell':''} ${mode==='face'?'ref-face-cell':''}" style="left:${tile.x*100}%;top:${tile.y*100}%;width:${tile.width*100}%;height:${tile.height*100}%"><button type="button" class="photo ref-photo-main ${mode==='face'&&selected?'selected-face':''}" data-action="${action}" data-id="${tile.id}" data-asset="${esc(asset)}" data-reference-screen="${route}" aria-label="${selection?(selected?'Deselect ':'Select '):mode==='face'?'':'Open '}${label}" ${selection||mode==='face'?`aria-pressed="${selected}"`:''}><img src="${esc(asset)}" alt="" loading="eager"></button>${showControl?`<button type="button" class="ref-control ${selected?'checked':''} ${tile.controlBaked?'baked-control':''} ${favorite?'favorite-control':''} ${tile.badgeOutlined?'outlined-favorite':''}" style="${badgeStyle}" data-action="${badgeAction}" data-id="${tile.id}" data-asset="${esc(asset)}" data-reference-screen="${route}" aria-label="${favorite?(selected?'Remove favorite':'Favorite'):(selected?'Deselect':'Select')} memory ${tile.id}" aria-pressed="${selected}">${selected?icon(favorite?'heart':'check'):''}</button>`:''}${tile.peopleBadge?`<button type="button" class="ref-people-badge" style="${tile.peopleBadgeBounds?`left:${tile.peopleBadgeBounds[0]*100}%;top:${tile.peopleBadgeBounds[1]*100}%;width:${tile.peopleBadgeBounds[2]*100}%;height:${tile.peopleBadgeBounds[3]*100}%;`:''}" data-action="people-from-grid" data-id="${tile.id}" data-asset="${esc(asset)}" aria-label="People in memory ${tile.id}">${icon('people')}</button>`:''}</div>`;
    }).join('')}</div>`;
  }
  function dynamicReviewGallery(){
    const ids=[...state.selectedPhotos];
    return `<div class="review-gallery dynamic-review-gallery">${ids.map(id=>`<button type="button" class="photo" data-action="view-photo" data-id="${id}" data-asset="${esc(state.selectionAssets[id]||canonicalAssets(29)[id]||photoURL(id))}" aria-label="Open selected memory ${id}"><img src="${esc(state.selectionAssets[id]||canonicalAssets(29)[id]||photoURL(id))}" alt=""></button>`).join('')}</div>`;
  }
  const screens = {
    1:()=>`<section class="screen splash" style="background-image:linear-gradient(#10020c18,#21071938),url('${ASSETS}splash.jpg')"><img class="splash-mark" src="${ASSETS}wordmark.png" alt="Lovelies"><p class="splash-tagline">PHOTOS BRING<br>PEOPLE CLOSER</p>${button('','go','data-target="2" aria-label="Get started"','splash-next','next')}</section>`,
    2:()=>`<section class="screen intro source-intro">${sourceArt('intro-collage.png','source-intro-art')}<h2>Your photos<br>find their people</h2><div class="intro-steps">${[['face','We match<br>your photos','matching'],['people','To the<br>right people','people'],['share','You choose<br>what to share','sharing']].map(([sym,label,type])=>`<button type="button" class="intro-step" data-action="how-it-works" data-value="${type}" style="background:none;border:0;padding:0"><span class="step-icon">${icon(sym)}</span>${label}</button>`).join('')}</div>${primary('Get Started','go','data-target="3"')}<div class="page-dots" role="group" aria-label="Introduction pages">${[0,1,2].map(i=>`<button type="button" data-action="intro-page" data-id="${i}" aria-label="Introduction page ${i+1}" ${i===0?'aria-current="step"':''}></button>`).join('')}</div></section>`,
    3:()=>`<section class="screen welcome glow"><img class="welcome-mark" src="${ASSETS}wordmark.png" alt="Lovelies"><h2>Welcome</h2><p>Same photos.<br>More people in them.</p><div class="auth-actions"><button type="button" class="auth-button apple" data-action="auth" data-value="Apple"><span class="apple-mark" aria-hidden="true"></span>Continue with Apple</button><button type="button" class="auth-button" data-action="auth" data-value="Google"><span class="google-mark" aria-hidden="true">G</span>Continue with Google</button>${primary('Create Account','create-account')}</div>${button('Sign In','sign-in','','text-button')}</section>`,
    4:()=>`<section class="screen access-prompt"><div class="access-backdrop" aria-hidden="true" inert>${gallery([4,7,11,2,17,13,15,1,5,6,8,10])}</div><div class="permission-modal">${heartArt()}<h2>“Lovelies” Would Like<br>to Access Your Photos</h2><p>Choose which photos Lovelies can access.<br>You review what to share.</p>${button('Allow Full Access','allow-access','data-value="all"','')}${button('Allow Limited Access','allow-access','data-value="limited"','')}${button('Not Now','access-later','','not-now')}</div></section>`,
    5:()=>`<section class="screen access-choice">${header('Choose Photo Access',{back:4})}<div class="access-options">${[['all','photo','All Photos','Get the best matches<br>across your entire library'],['albums','albums','Selected Albums','Choose specific albums'],['limited','lock','Limited Access','Start with a few photos<br>(you can change this anytime)']].map(([value,sym,title,sub])=>`<label class="access-card ${state.access===value?'chosen':''}"><input class="radio" type="radio" name="access" value="${value}" data-setting="access" aria-label="${title}" ${state.access===value?'checked':''}><span class="row-icon">${icon(sym)}</span><span class="row-main"><strong>${title}</strong><small>${sub}</small></span></label>`).join('')}</div><div class="bottom-action">${primary('Continue','enroll-start')}</div></section>`,
    6:()=>`<section class="screen face-enroll"><div class="camera-frame"><img src="${ASSETS}portrait.jpg" alt="Face enrollment camera preview"></div><button type="button" class="shutter" data-action="capture" aria-label="Capture selfie ${state.pose+1} of 3"></button><p>${['Position your face<br>in the frame','Turn slightly to the left<br>for your second selfie','Turn slightly to the right<br>for your third selfie'][Math.min(state.pose,2)]}</p>${state.pose?`<div class="capture-dots" aria-label="${state.pose} of 3 selfies captured">${[0,1,2].map(i=>`<span class="${i<state.pose?'complete':''}"></span>`).join('')}</div>`:''}</section>`,
    7:()=>`<section class="screen face-retry">${header('',{back:6,left:iconButton('close','back','Close face retry','data-target="6"')})}<div class="camera-frame"><img src="${ASSETS}retry-portrait.jpg" alt="Face photo that needs another try"><span class="retry-symbol" aria-hidden="true">!</span></div><h2>Let’s try that again</h2><p>Make sure your face is well lit,<br>in focus, and centered.</p><div class="bottom-action">${primary('Retake','enroll-start')}${button('Review Sample Result','process-setup','','secondary')}</div></section>`,
    8:()=>`<section class="screen center-screen processing-screen source-art-screen source-art-8">${sourceArt('processing-hero.png')}<h2>Finding your photos…</h2><p>This won’t take long</p></section>`,
    9:()=>`<section class="screen center-screen source-art-screen source-art-9">${sourceArt('setup-hero.png')}<h2>You’re all set!</h2><p>We’ve matched your photos<br>to the people in them.</p><div class="bottom-action">${primary('Let’s Go','go','data-target="10"')}</div></section>`,
    10:()=>`<section class="screen edge home-screen"><header class="gallery-header"><button type="button" data-action="go" data-target="10" aria-label="Lovelies home" style="border:0;padding:0;background:none"><img class="wordmark" src="${ASSETS}wordmark.png" alt="Lovelies"></button><div class="header-actions">${iconButton('search','go','Search photos','data-target="15"')}${iconButton('bell','go','Notifications','data-target="18"')}</div></header><div class="gallery-wrap">${homeGallery()}</div>${bottomNav('home')}</section>`,
    11:()=>`<section class="screen edge source-matches-screen">${header('New Matches',{back:10,right:iconButton('next','go','Match results summary','data-target="25"','small'),titleLeft:true})}<div class="people-strip" style="padding:0 8px">${[1,5,7,3].map((id,i)=>personBubble(id,{count:[24,18,12,'+6'][i]})).join('')}</div><div class="gallery-wrap">${referenceGrid(11,{selection:state.newMatchSelections,mode:'matches'})}</div>${bottomNav('people')}</section>`,
    12:()=>`<section class="screen viewer"><img class="viewer-image" src="${activePhotoURL()}" alt="${esc(photoMetadata[state.activePhoto-1]?.title||'Photo')}"><div class="viewer-top">${iconButton('back','back','Back to gallery')}${iconButton('more','photo-menu','Photo options','','circle')}</div><div class="viewer-bottom"><div class="mini-people">${avatar(1)}${avatar(3)}<button type="button" data-action="go" data-target="27" aria-label="See all people in this photo">+3</button></div>${iconButton('heart','favorite','Save to favorites',`data-id="${state.activePhoto}" aria-pressed="${state.favorites.has(state.activePhoto)}"`,state.favorites.has(state.activePhoto)?'favorite-on':'')}${iconButton('share','share-one','Share this photo')}</div></section>`,
    13:()=>`<section class="screen edge">${header('Photos',{back:10,right:iconButton('grid','gallery-layout','Change photo grid layout'),titleLeft:true})}${chips(['All','People','Places','Videos'],state.photoTab,'photo-tab')}<div class="gallery-wrap">${state.photoTab==='All'?defaultLibraryGallery():gallery(libraryPhotos())}</div></section>`,
    14:()=>`<section class="screen favorites-screen source-favorites-screen"><header class="favorites-header">${iconButton('back','back','Back','data-target="10"') }<span class="favorites-heart" aria-hidden="true">${icon('heart')}</span><h2>Favorites</h2>${iconButton('more','favorites-menu','Favorite options','','circle')}</header><div class="gallery-wrap">${referenceGrid(14,{selection:state.referenceSaved,mode:'favorites'})}</div></section>`,
    15:()=>`<section class="screen search-screen source-search-screen">${header('Search',{right:iconButton('filter','go','Open filters','data-target="16"'),titleLeft:true})}<div class="search-field">${icon('search')}<input type="search" id="photo-search" data-input="photo-search" placeholder="Search photos, people, places…" aria-label="Search photos, people, places" value="${esc(state.search)}">${iconButton('filter','go','Open photo filters','data-target="16"')}</div>${catButtons()}<div class="section-label recent-label">Recent</div><div class="recent-categories">${[['Sunsets',1],['Travel',7],['Friends',11],['Food',8]].map(([label,id],i)=>`<button type="button" class="recent-category" data-action="recent-search" data-value="${label}"><img src="${referenceLayouts['15']?.recentAssets?.[i]?GRID_ASSETS+referenceLayouts['15'].recentAssets[i]:photoURL(id)}" alt="">${label}</button>`).join('')}</div><div class="section-label results-label" id="search-result-heading">Results</div><div class="gallery-wrap" id="photo-results">${searchResults()}</div></section>`,
    16:()=>`<section class="screen filters-screen">${header('Filters',{back:15,right:button('Reset','reset-filters','','text-button')})}${catButtons(state.filterCategory,'filter-category')}<div class="filter-heading">${state.filterCategory}</div><div class="filter-people">${[1,2,3].map(id=>`<button type="button" data-action="filter-person" data-id="${id}" aria-label="Filter by ${people[id-1].name}" aria-pressed="${state.filterPeople.has(id)}">${avatar(id,state.filterPeople.has(id)?'pink-ring':'')}</button>`).join('')}<button type="button" class="add-person" data-action="filter-add-person" aria-label="Add a person filter">+</button></div><div class="filter-heading">Date Range</div><div class="list-group">${row('calendar',state.dateRange,{action:'date-filter'})}</div><div class="filter-heading">Location</div><div class="list-group">${row('pin',state.location,{action:'location-filter'})}</div><div class="filter-heading">Media Type</div><div class="category-grid media-grid">${[['Photos','photo'],['Videos','video'],['Live Photos','live']].map(([label,sym])=>`<button type="button" class="category-button" data-action="media-type" data-value="${label}" aria-pressed="${state.mediaType===label}">${icon(sym)}<span>${label}</span></button>`).join('')}</div><div class="bottom-action">${primary('Show Results (342)','apply-filters')}</div></section>`,
    17:()=>`<section class="screen activity-screen">${header('Activity',{titleLeft:true})}${chips(['All','Matches','Shares','Mentions'],state.activityTab,'activity-tab')}<div class="scroll-content">${activityRows()}</div></section>`,
    18:()=>`<section class="screen notifications-screen">${header('Notifications',{titleLeft:true})}${chips(['All','People','System'],state.notificationTab,'notification-tab')}<div class="scroll-content">${notificationRows()}</div></section>`,
    19:()=>`<section class="screen upload-entry">${header('Add Photos',{left:iconButton('close','back','Close upload','data-target="10"')})}${heartArt()}<p>Add your photos<br>to find their people.</p><div class="source-shortcuts">${[['Device','photo'],['Albums','albums'],['Files','file'],['Camera','camera']].map(([label,sym])=>`<button type="button" class="source-shortcut" data-action="upload-source" data-value="${label}"><span class="source-circle">${icon(sym)}</span><span>${label}</span></button>`).join('')}</div></section>`,
    20:sourcePicker,
    21:()=>`<section class="screen edge select-upload source-upload-select">${header(`${state.uploadPhotos.size} selected`,{subtitle:uploadSourceContext(),left:button('Cancel','back','data-target="20"','text-button'),right:button('Next','go',`data-target="22" ${state.uploadPhotos.size?'':'disabled'}`,'next-chip')})}<div class="gallery-wrap">${referenceGrid(21,{selection:state.uploadPhotos,mode:'upload'})}</div></section>`,
    22:()=>`<section class="screen upload-review">${header('Review Upload',{back:21,subtitle:uploadSourceContext()})}<div class="upload-strip">${[...state.uploadPhotos].slice(0,5).map(id=>photo(id)).join('')}${state.uploadPhotos.size>5?`<span class="more-tile">+${state.uploadPhotos.size-5}</span>`:''}</div><input class="field" type="text" data-input="caption" placeholder="Add a caption (optional)" aria-label="Upload caption" value="${esc(state.caption)}"><div class="list-group">${row('photo','Add to album',{value:state.album,action:'album-picker'})}</div><div class="list-group">${row('lock','Who can see these?',{value:state.visibility,action:'visibility-picker'})}</div><div class="bottom-action">${primary('Start Upload','upload-start',state.uploadPhotos.size?'':'disabled')}</div></section>`,
    23:()=>`<section class="screen upload-progress">${header('Uploading…',{left:iconButton('close','cancel-upload','Cancel upload')})}<div class="scroll-content">${[...state.uploadPhotos].slice(0,5).map((id,i)=>{const percent=Math.max(0,Math.min(100,state.uploadProgress-i*36));const label=percent===100?'Complete':percent>0?`Uploading · ${percent}%`:i===2?'Processing…':'Waiting…';return `<div class="upload-item"><img src="${photoURL(id)}" alt="${esc(photoMetadata[id-1].title)}"><div class="row-main"><strong>IMG_${2931+i}.${i===2?'MOV':'JPG'}</strong><small>${label}</small><span class="progress-track"><i style="--progress:${percent||(i===2?78:0)}%"></i></span></div><span class="progress-dot ${percent===100?'done':''}" aria-hidden="true"></span></div>`}).join('')}</div></section>`,
    24:()=>`<section class="screen upload-complete source-art-24">${sourceArt('upload-hero.png')}<h2>Upload complete!</h2><p>${state.uploadPhotos.size} photos added to your library<br>and ready to find their people.</p>${primary('View in Library','go','data-target="13"')}<div class="section-label"><span>Recent Uploads</span>${iconButton('next','go','View recent uploads','data-target="13"','small')}</div><div class="recent-upload-row">${[...state.uploadPhotos].slice(0,5).map(id=>photo(id)).join('')}<span class="chevron">›</span></div><p class="small-copy">Just now · ${state.uploadPhotos.size} photos</p></section>`,
    25:()=>`<section class="screen center-screen summary-screen glow source-art-screen source-art-25">${sourceArt('matches-hero.png')}<div class="summary-stat"><strong>12</strong><span>Photos Matched</span></div><div class="summary-stat"><strong>8</strong><span>People Found</span></div><div class="avatar-stack">${[5,3,1,7,8].map(id=>avatar(id)).join('')}<span class="more-people">+4</span></div><p>Great matches!<br>Your photos found people<br>in your memories.</p><div class="bottom-action">${primary('View Matches','go','data-target="26"')}</div></section>`,
    26:()=>`<section class="screen edge source-matched-gallery">${header('Matched Photos',{back:25,subtitle:'12 photos',right:iconButton('more','matches-menu','Matched photo options','','circle')})}<div class="gallery-wrap">${referenceGrid(26)}</div></section>`,
    27:()=>`<section class="screen viewer photo-people"><img class="viewer-image" src="${activePhotoURL()}" alt="${esc(photoMetadata[state.activePhoto-1]?.title||'Photo')}"><div class="viewer-top">${iconButton('back','back','Back to photo','data-target="12"')}<span style="background:#53434c88;border-radius:13px;padding:4px 9px;align-self:center;font-size:.875rem">1/12</span></div><section class="people-sheet">${header('People in this photo',{back:12,right:iconButton('more','people-photo-menu','People in photo options','','circle small')})}<div class="people-grid">${people.slice(0,7).map(p=>personBubble(p.id,{label:true})).join('')}<button type="button" class="person-bubble more" data-action="show-all-people" aria-label="See two more people">+2</button></div></section></section>`,
    28:()=>`<section class="screen edge source-person-photos">${header('',{back:27,right:iconButton('more','person-menu','Person options','','circle')})}<div class="person-photo-header">${avatar(state.activePerson)}<h2>${esc(people[state.activePerson-1]?.name||'Sophie')}</h2><p>${people[state.activePerson-1]?.count||6} matched photos</p></div><div class="gallery-wrap">${referenceGrid(28)}</div></section>`,
    29:()=>photoSelection(false),
    30:()=>photoSelection(true),
    31:()=>`<section class="screen people-selection">${header('Choose People to Share With',{back:29,subtitle:`${state.selectedPeople.size} of ${shareablePeople().length} selected`,right:iconButton('more','people-select-menu','People selection options','','circle')})}<div class="people-list">${peopleRows(state.selectedPeople)}</div><div class="bottom-action">${primary('Continue','go',`data-target="33" ${state.selectedPeople.size&&state.selectedPhotos.size?'':'disabled'}`)}</div></section>`,
    32:()=>`<section class="screen people-selection">${header('Deselect People',{back:31,subtitle:`${state.selectedPeople.size} of ${shareablePeople().length} selected`,right:iconButton('more','people-select-menu','People selection options','','circle')})}<div class="people-list">${peopleRows(state.selectedPeople)}</div><div class="bottom-action">${primary('Continue','go',`data-target="33" ${state.selectedPeople.size&&state.selectedPhotos.size?'':'disabled'}`)}</div></section>`,
    33:()=>`<section class="screen review-share glow source-review-share">${header('Review & Share',{back:31})}<div class="section-label"><span>Photos (${state.selectedPhotos.size})</span>${button('Edit','go','data-target="30"','')}</div>${state.reviewReferenceFixture?`<div class="reference-review-montage">${referenceGrid(33,{filterIds:state.selectedPhotos})}</div>`:dynamicReviewGallery()}<div class="section-label ref-people-label"><span>People (${state.selectedPeople.size})</span>${button('Edit','go','data-target="32"','')}</div><div class="review-people">${[...state.selectedPeople].slice(0,5).map(id=>personBubble(id,{label:true})).join('')}</div><div class="review-notice">You’re about to share ${state.selectedPhotos.size} photos<br>with ${state.selectedPeople.size} ${state.selectedPeople.size===1?'person':'people'}.</div><div class="bottom-action">${primary('Share Photos','share-start',state.selectedPhotos.size&&state.selectedPeople.size?'':'disabled','share')}</div></section>`,
    34:()=>`<section class="screen sharing-screen glow source-art-34"><h2 class="sharing-title">Sharing Your Photos</h2>${sourceArt('sharing-hero.png')}<h2>Sharing with ${state.selectedPeople.size} ${state.selectedPeople.size===1?'person':'people'}…</h2><p>This won’t take long.</p><div class="sharing-steps">${['Preparing photos','Finding your people','Sending…','Almost there!'].map((label,i)=>`<div class="sharing-step"><span class="progress-dot ${i<state.sharingProgress?'done':''}"></span><span>${label}</span></div>`).join('')}</div></section>`,
    35:()=>`<section class="screen shared-history">${header('Shared with People',{back:10,right:iconButton('more','history-menu','Shared history options','','circle')})}<div class="scroll-content">${[1,5,7].map((id,i)=>historyRow(id,i)).join('')}<div class="section-label">Earlier</div>${[2,3,4].map((id,i)=>historyRow(id,i+3)).join('')}</div></section>`,
    36:()=>`<section class="screen report-screen">${header('',{back:28,right:iconButton('more','report-help','About match reports','','circle')})}<div class="report-hero">${avatar(state.activePerson===1?2:state.activePerson)}<h2>Not this person?</h2><p>Help us improve by letting us know<br>this isn’t the right match.</p></div><div class="report-options">${[['This isn’t me','person'],['Wrong person','face'],['Not in this photo','photo'],['Other issue','shield']].map(([reason,sym])=>`<label class="report-option"><span class="row-icon">${icon(sym)}</span><span>${esc(reason)}</span><input class="radio" type="radio" name="report-reason" data-setting="reportReason" value="${esc(reason)}" aria-label="${esc(reason)}" ${state.reportReason===reason?'checked':''}></label>`).join('')}</div><div class="bottom-action">${primary(state.reportSubmitted?'Submitted':'Submit','submit-report',state.reportSubmitted?'disabled':'')}</div></section>`,
    37:()=>`<section class="screen profile-screen glow source-profile-screen">${iconButton('more','profile-menu','Profile settings','','circle profile-menu')}<div class="profile-hero"><div class="profile-avatar">${avatar(1)}${iconButton('edit','edit-profile','Edit profile picture')}</div><h2>${esc(state.name)}</h2><p>${esc(state.bio).replace(/\n/g,'<br>')}</p></div><div class="profile-stats">${[['248','Photos',13],['36','Matches',25],[matchedRecipients.length,'People',39]].map(([count,label,target])=>`<button type="button" data-action="go" data-target="${target}">${count}<small>${label}</small></button>`).join('')}</div>${primary('Edit Profile','edit-profile')}<div class="profile-tabs" role="group" aria-label="Profile gallery categories">${[['photos','grid'],['favorites','heart'],['people','person']].map(([value,sym])=>`<button type="button" data-action="profile-tab" data-value="${value}" aria-label="${value}" aria-pressed="${state.profileTab===value}">${icon(sym)}</button>`).join('')}</div><div class="gallery-wrap">${state.profileTab==='people'?`<div class="people-grid">${people.map(p=>personBubble(p.id,{label:true})).join('')}</div>`:state.profileTab==='favorites'?gallery([...state.favorites],{favorites:true}):referenceGrid(37)}</div>${bottomNav('person',true)}</section>`,
    38:()=>`<section class="screen face-management source-face-management">${header('Manage Your Face',{back:37})}<p>Help Lovelies find you in photos<br>across your matches.</p><div class="camera-frame"><img src="${referenceLayouts['38']?.cameraAsset?GRID_ASSETS+referenceLayouts['38'].cameraAsset:ASSETS+'portrait.jpg'}" alt="Your enrolled face"></div><div class="reference-face-thumbnails">${referenceGrid(38,{mode:'face'})}</div>${primary('Replace Face','replace-face')}<div class="list-group">${row('bulb','Tips for best results',{action:'face-tips'})}</div></section>`,
    39:()=>`<section class="screen manage-people">${header('Manage People',{back:37})}<p class="manage-people-note">Matched people are allowed by default. Block anyone you don’t want to share with.</p><div class="tabs-pill">${['Allowed','Blocked'].map(label=>button(`${label} (${managedRecipients(label).length})`,'recipient-tab',`data-value="${label}" aria-pressed="${state.recipientTab===label}"`,'')).join('')}</div><div class="people-list">${recipientRows()}</div></section>`,
    40:()=>`<section class="screen privacy-screen">${header('Privacy & Sharing',{back:37})}<div class="list-group">${row('person','Who can find you',{subtitle:state.findable,action:'find-privacy'})}${row('photo','Photo visibility',{subtitle:state.visibility,action:'visibility-picker'})}${row('share','Allow others to save',{toggle:{group:'privacy',key:'saving'}})}${row('pin','Show location info',{toggle:{group:'privacy',key:'location'}})}${row('star','Show in suggestions',{toggle:{group:'privacy',key:'suggestions'}})}${row('analytics','Analytics',{subtitle:'Help us improve Lovelies',toggle:{group:'privacy',key:'analytics'}})}</div><div class="privacy-notice"><span class="row-icon">${icon('shieldCheck')}</span><div><strong>Your privacy matters</strong><p>You choose each photo<br>and recipient before sharing.</p></div></div></section>`,
    41:()=>`<section class="screen photo-access-settings">${header('Photo Access',{back:37})}${heartArt()}<p>Lovelies needs access to your<br>photos to find people in them.</p><div class="list-group">${[['all','All Photos','Access to your entire library'],['albums','Selected Albums','Choose specific albums'],['limited','Limited Access','Allow only certain photos']].map(([value,title,subtitle])=>`<label class="access-setting-row ${state.access===value?'chosen':''}"><span class="access-leading">${state.access===value?'✓':''}</span><span class="row-main"><strong>${title}</strong><small>${subtitle}</small></span><input class="radio" type="radio" name="access" data-setting="access" value="${value}" aria-label="${title}" ${state.access===value?'checked':''}></label>`).join('')}</div><div class="bottom-action">${primary('Continue','save-access')}</div></section>`,
    42:()=>`<section class="screen notification-settings">${header('Notifications',{back:37})}<div class="list-group">${[['heart','New Matches','When you’re matched in photos','matches'],['message','Messages','When you receive a message','messages'],['mention','Mentions','When someone mentions you','mentions'],['bulb','Tips & Features','Product updates and tips','tips'],['phone','Reminders','Friendly nudges','reminders'],['megaphone','Marketing','Special offers (optional)','marketing']].map(([sym,title,subtitle,key])=>row(sym,title,{subtitle,toggle:{group:'notifications',key}})).join('')}</div></section>`,
    43:()=>`<section class="screen storage-screen">${header('Storage',{back:37})}<div class="storage-chart"><div class="storage-copy"><strong>${state.cacheCleared?'2.2':'2.4'} GB</strong><small>of 5 GB used</small></div></div><div class="storage-legend">${[['Photos','1.8 GB',''],['Matches','420 MB','purple'],['Cache',state.cacheCleared?'0 MB':'180 MB','cream'],['Other','60 MB','cream']].map(([title,value,cls])=>`<div><span class="storage-dot ${cls}"></span><span>${title}</span><span>${value}</span></div>`).join('')}</div><div class="bottom-action">${primary('Manage Storage','manage-storage')}</div></section>`,
    44:()=>`<section class="screen export-screen">${header('Export Your Data',{back:37})}<div class="export-icon">${icon('downloadFile')}</div><p>Download a copy of your<br>photos, matches and profile data.</p><div class="export-description"><span class="row-icon">${icon('bulb')}</span><div><strong>Your data, your choice</strong><ul><li>Photos you’ve shared</li><li>Your matches and messages</li><li>Profile information</li><li>Settings and preferences</li></ul></div></div><div class="bottom-action">${primary(state.exported?'Export Requested':'Request Export','request-export',state.exported?'disabled':'')}</div></section>`,
    45:()=>`<section class="screen help-screen">${header('Help Center',{back:37})}<label class="search-field">${icon('search')}<input type="search" data-input="help-search" placeholder="Search for help…" aria-label="Search help topics" value="${esc(state.helpSearch)}"></label><div class="scroll-content" id="help-results"><div class="list-group">${helpRows()}</div></div></section>`,
    46:()=>`<section class="screen security-screen">${header('Account & Security',{back:37})}<div class="list-group">${row('mail','Email',{value:state.email,action:'security-email'})}${row('phone','Phone',{value:state.phone,action:'security-phone'})}${row('lock','Password',{value:'••••••••',action:'security-password'})}${row('shield','Two-Factor Authentication',{value:state.twoFactor?'On':'Off',action:'security-2fa'})}${row('laptop','Active Devices',{value:`${state.devices} devices`,action:'security-devices'})}</div><div class="list-group destructive">${row('logout','Sign Out',{action:'sign-out'})}${row('trash','Delete Account',{action:'delete-account'})}</div></section>`,
    47:()=>`<section class="screen center-screen empty-matches source-art-screen source-art-47">${sourceArt('empty-hero.png')}<h2>No Matches Yet</h2><p>Your people are out there.<br>Keep sharing your photos<br>and we’ll find them!</p><div class="bottom-action">${primary('Keep Exploring','go','data-target="10"')}</div></section>`,
    48:()=>`<section class="screen center-screen offline-screen source-art-screen source-art-48">${sourceArt('offline-hero.png')}<h2>You’re Offline</h2><p>Check your connection<br>and try again.</p><div class="bottom-action">${primary('Try Again','retry-connection')}${button('Go Back','back','','text-button')}</div></section>`
  };

  function homeGallery() {
    return `<div class="home-gallery" role="group" aria-label="Your photo gallery">${homeTiles.map(tile=>`<button type="button" class="photo home-photo" data-action="view-photo" data-origin="home" data-asset="${esc(tile.asset)}" data-id="${tile.id}" aria-label="Open memory ${tile.id}" style="left:${tile.x*100}%;top:${tile.y*100}%;width:${tile.width*100}%;height:${tile.height*100}%"><img src="${ASSETS}${esc(tile.asset)}" alt="" loading="eager"></button>`).join('')}</div>`;
  }
  function libraryPhotos() {
    return state.photoTab==='People'?[5,8,10,11,17,18,1,16]:state.photoTab==='Places'?[2,4,7,13,14,15,6]:state.photoTab==='Videos'?[12,6,5,10]:[2,4,9,10,13,1,5,7,17,3,8,12,15,16,18];
  }
  function defaultLibraryGallery() {
    const columns=[[[2,.72],[4,.74],[9,1.32],[10,.68]],[[1,.65],[6,1.06],[7,.96],[11,1]],[[3,.98],[5,.90],[8,.69],[12,.98],[14,.78]]];
    return `<div class="source-library-grid">${columns.map(tiles=>`<div class="source-library-column">${tiles.map(([id,ratio])=>`<div style="--photo-ratio:${ratio}">${photo(id)}</div>`).join('')}</div>`).join('')}</div>`;
  }
  function searchResults() {
    const query=state.search.trim().toLowerCase();
    if(!query&&!state.filtersApplied&&referenceLayouts['15'])return referenceGrid(15,{selection:state.searchSelections,mode:'search'});
    let ids=query?photoMetadata.filter(p=>`${p.title} ${p.tags}`.toLowerCase().includes(query)).map(p=>p.id):[1,6,11,10,7,16,13,17,4];
    if(state.filtersApplied){
      const base=query?ids:photoMetadata.map(p=>p.id);
      ids=base.filter(id=>{
        if(state.mediaType==='Videos'&&![5,6,12].includes(id))return false;
        if(state.mediaType==='Live Photos'&&![1,6,10,16].includes(id))return false;
        if(state.dateRange==='This week'&&id%3!==0)return false;
        if(state.dateRange==='This month'&&id%2!==0)return false;
        if(state.location==='Italy'&&![1,2,4,5,8,13,14,15].includes(id))return false;
        if(state.location==='Switzerland'&&![7,16].includes(id))return false;
        if(state.location==='By the sea'&&![1,2,6,13].includes(id))return false;
        if(state.filterCategory==='People'&&state.filterPeople.size){const found=new Set([id%8+1,(id+2)%8+1,1]);if(![...state.filterPeople].some(person=>found.has(person)))return false;}
        return true;
      });
    }
    return ids.length?gallery(ids,{selected:query?null:new Set([10,13,17]),action:'view-photo'}):`<div class="empty-search"><strong>No photos found</strong><p>Try a person, place, or another memory.</p></div>`;
  }
  function photoSelection(deselect) {
    return `<section class="screen edge photo-selection source-photo-selection">${header(deselect?'Deselect Photos':'Select Photos to Share',{back:deselect?29:26,subtitle:`${state.selectedPhotos.size} of 12 selected`,right:iconButton('more','photo-select-menu','Photo selection options','','circle')})}<div class="gallery-wrap">${referenceGrid(deselect?30:29,{selection:state.selectedPhotos,mode:'selection',overrideAssets:state.selectionAssets})}</div><div class="selection-footer">${iconButton('share','photo-select-menu','Selection options')}<span>${state.selectedPhotos.size} selected</span>${iconButton('next','go','Continue to choose people',`data-target="31" ${state.selectedPhotos.size?'':'disabled'}`,'pink')}</div></section>`;
  }
  function historyRow(id,index) {
    const earlier=index>2;const person=people[id-1];
    return `<div class="history-row">${earlier?avatar(id):`<div class="history-photo"><img src="${photoURL([1,6,7][index]||1)}" alt="Shared photo">${avatar(id)}</div>`}<button type="button" class="row-main" data-action="person-view" data-id="${id}" style="background:none;padding:0;border:0;color:inherit;text-align:left"><strong>${person.name}</strong><small>${earlier?[4,2,3][index-3]:state.selectedPhotos.size} photos · ${index===0?'Just now':earlier?`${index-2}d ago`:'2m ago'}</small></button><span class="delivery-badge ${earlier?(index===5?'sent':'viewed'):''}">${earlier?(index===5?'● Sent':'✓ Viewed'):'● Delivered'}</span></div>`;
  }
  function activityRows() {
    const rows=[['Matches',7,'Maya matched<br>with your photos','2m ago',5,'heart'],['Mentions',5,'Alex liked 3 of<br>your photos','12m ago',6,'heart'],['Matches',0,'You and Sam<br>matched on 12 photos','1h ago',11,'link'],['Shares',3,'Priya shared<br>a photo with you','3h ago',10,'share'],['Matches',0,'New people found<br>in your photos','5h ago',7,'people']];
    return rows.filter(r=>state.activityTab==='All'||r[0]===state.activityTab).map(([type,id,text,time,photoId,sym])=>`<button type="button" class="activity-row" data-action="go" data-target="${type==='Shares'?35:type==='Mentions'?12:25}" aria-label="${esc(text.replace(/<br>/g,' '))}">${id?`<span class="activity-avatar">${avatar(id)}<span class="badge">${sym==='heart'?'♥':'↥'}</span></span>`:`<span class="row-icon">${icon(sym)}</span>`}<span class="row-main"><strong>${text}</strong><small>${time}</small></span><img class="activity-thumb" src="${photoURL(photoId)}" alt=""><span class="chevron">›</span></button>`).join('');
  }
  function notificationRows() {
    const rows=[['System','heart','You have 5 new matches!','2m ago',25],['People','personAdd','Emma joined Lovelies<br>and found you','14m ago',28],['People','message','Taylor commented<br>on your photo','1h ago',12],['People','share','Jordan shared a photo<br>with you','2h ago',35],['System','bell','Your upload is complete','3h ago',24],['System','star','New memories ready<br>to explore','5h ago',13]];
    return rows.filter(r=>state.notificationTab==='All'||r[0]===state.notificationTab).map(([,sym,text,time,target])=>`<button type="button" class="notification-row" data-action="go" data-target="${target}" aria-label="${esc(text.replace(/<br>/g,' '))}"><span class="row-icon ${['heart','bell','star','message'].includes(sym)?'filled':''}">${icon(sym)}</span><span class="row-main"><strong>${text}</strong><small>${time}</small></span><span class="chevron">›</span></button>`).join('');
  }
  function recipientRows() {
    return managedRecipients(state.recipientTab).map(p=>`<button type="button" class="person-select-row" data-action="manage-recipient" data-id="${p.id}">${avatar(p.avatarId,'',p.name)}<span class="row-main"><strong>${p.name}</strong></span><span class="row-value">${state.blocked.has(p.id)?'Blocked':'Can share with'}</span><span class="chevron">›</span></button>`).join('')||`<div class="empty-search"><strong>${state.recipientTab==='Blocked'?'No blocked people':'No allowed people'}</strong><p>${state.recipientTab==='Blocked'?'All matched people are available for future shares.':'Unblock a matched person to make them available for future shares.'}</p></div>`;
  }
  const helpTopics=[['shield','Getting Started','Learn the basics','Choose photo access, then take three clear selfies. Lovelies helps find your people; you choose what to share.'],['photo','Your Photos','Uploading, matching and more','Use Add Photos to choose memories, review your album and visibility, then continue to your library. Tap a photo to explore people and save favorites.'],['shieldCheck','Privacy & Safety','Keeping your data safe','Manage allowed and blocked people in your profile. Choose your photo visibility and whether others may save your photos.'],['settings','Account & Settings','Manage your account','Open your profile menu to manage your face, privacy, photo access, notifications, storage and account security.'],['help','Troubleshooting','Fix common issues','For unclear selfies, choose Retake and use even lighting. If you see the offline screen, try again or return to your library.'],['bag','Contact Support','We’re here to help','Describe the issue and the screen where it happened. You can prepare a support request here.']];
  function helpRows() {
    const q=state.helpSearch.toLowerCase();
    const hits=helpTopics.map((topic,index)=>({topic,index})).filter(({topic})=>`${topic[1]} ${topic[2]} ${topic[3]}`.toLowerCase().includes(q));
    return hits.length?hits.map(({topic:[sym,title,subtitle],index})=>row(sym,title,{subtitle,action:'help-topic',extra:`data-id="${index}"`})).join(''):'<div class="empty-search"><strong>No help topics found</strong><p>Try “photos”, “privacy” or “account”.</p></div>';
  }

  function seedReference(id) {
    if(id===1) state.pose=0;
    if(id===21) state.uploadPhotos=new Set(uploadDefault);
    if(id===23) state.uploadProgress=78;
    if(id===13)state.photoTab='All';
    if(id===14)state.referenceSaved=new Set([2,3,4,5]);
    if(id===15){state.search='';state.filtersApplied=false;state.searchSelections=new Set([4,6,7]);}
    if(id===29||id===30){state.selectedPhotos=selectedFixture(id);state.selectionAssets=canonicalAssets(29);state.reviewReferenceFixture=false;}
    if(id===31) state.selectedPeople=new Set([1,2,3,5,7]);
    if(id===32) state.selectedPeople=new Set([1,5,7]);
    if(id===33||id===34||id===35){state.selectedPhotos=new Set([1,2,3,4,5,6]);state.selectedPeople=new Set([1,5,7]);state.selectionAssets=canonicalAssets(33);state.reviewReferenceFixture=id===33;}
    if(id===37)state.profileTab='photos';
    if(id===12||id===27){state.activePhoto=1;state.activePhotoAsset=null;}
    if(id===28) state.activePerson=1;
  }
  function go(id,{referenceState=false,replace=false,fromHistory=false,trail=null,resetTrail=false,direction='forward'}={}) {
    const next=Math.max(1,Math.min(48,Number(id)||10));
    if(next===state.screen&&!referenceState&&!replace&&!fromHistory){render();return;}
    saveRouteView();
    clearTimeout(searchAnnouncementTimer);
    if(progressTimer){clearInterval(progressTimer);progressTimer=null;}
    if(dialog.open)dialog.close();
    if(referenceState)seedReference(next);
    if(next===33&&!referenceState)state.reviewReferenceFixture=false;
    if(resetTrail)state.trail=[];
    else if(fromHistory)state.trail=trail||[];
    else if(referenceState)state.trail=[];
    else if(!replace&&state.screen!==next)state.trail.push(state.screen);
    state.screen=next;
    app.dataset.navigation=direction;
    if(!fromHistory){if(!replace)historyPosition++;history[replace?'replaceState':'pushState']({lovelies:true,screen:next,trail:[...state.trail],position:historyPosition},'',`#${next}`);}
    render();
  }
  function back(fallback=routeParents[state.screen]||10) {
    if(state.trail.length&&history.state?.lovelies)history.back();
    else go(fallback===state.screen?10:fallback,{replace:true,direction:'back'});
  }
  function render() {
    reconcileShareRecipients();
    const entry=catalog[state.screen-1];
    const sameScreen=device.dataset.screenId===String(state.screen);
    if(sameScreen)saveRouteView();
    const view=routeViews.get(state.screen);
    app.innerHTML=screens[state.screen]();
    app.tabIndex=-1;
    const screen=app.querySelector('.screen');
    screen.setAttribute('aria-label',entry.title);
    // Hero/status screens also need a visible, keyboard-reachable escape.
    if([2,3,4,6,8,9,24,25,34,47].includes(state.screen)) {
      const exit=document.createElement('div');exit.className='route-exit';
      exit.innerHTML=iconButton('back','back',[8,34].includes(state.screen)?'Cancel and go back':'Back',`data-target="${routeParents[state.screen]}"`);
      screen.prepend(exit);
    }
    const heading=[...screen.querySelectorAll('h2')].find(el=>el.textContent.trim());
    const routeFocus=heading||screen;
    routeFocus.tabIndex=-1;
    app.querySelectorAll('button img').forEach(img=>img.alt='');
    if(!sameScreen)screen.classList.add('route-enter');
    if([8,23,34].includes(state.screen)) {
      screen.setAttribute('aria-busy','true');
      screen.querySelectorAll('.progress-track').forEach((track,i)=>{
        track.setAttribute('role','progressbar');track.setAttribute('aria-label',`Upload ${i+1}`);
        track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');
        track.setAttribute('aria-valuenow',String(Math.max(0,Math.min(100,state.uploadProgress-i*36))));
      });
    }
    device.dataset.screenId=String(state.screen);
    device.style.setProperty('--reference-height',`${390 * entry.height / entry.width}px`);
    device.classList.toggle('android',state.platform==='android');
    device.classList.toggle('ios',state.platform==='ios');
    document.getElementById('screen-title').textContent=entry.title;
    document.getElementById('screen-counter').textContent=`${pad(state.screen)} / 48`;
    document.getElementById('screen-group').textContent=entry.group;
    document.getElementById('platform-caption').textContent=state.platform==='ios'?'iOS · native SwiftUI source':'Android · native Jetpack Compose source';
    document.getElementById('compare-button').setAttribute('aria-pressed',String(state.compare));
    document.getElementById('reference-column').hidden=!state.compare;
    document.getElementById('review-stage').classList.toggle('comparing',state.compare);
    const reference=document.getElementById('reference-image');
    if(entry.filename){reference.src=REFERENCES+entry.filename;reference.alt=`Supplied screenshot ${pad(entry.id)}: ${entry.title}`;}
    document.querySelectorAll('[data-action="platform"]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.platform===state.platform)));
    document.querySelectorAll('.catalog-link').forEach(el=>{if(Number(el.dataset.target)===state.screen)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
    document.querySelector('[data-action="previous-screen"]').disabled=state.screen===1;
    document.querySelector('[data-action="next-screen"]').disabled=state.screen===48;
    document.title=`${entry.title} · Lovelies`;
    [app,...app.querySelectorAll('.screen,.gallery-wrap,.scroll-content,.people-list')].forEach((el,i)=>el.scrollTop=view?.scroll[i]||0);
    if(sameScreen&&view?.focus) {
      const matching=findFocus(view.focus);matching?.focus({preventScroll:true});
      if(matching&&view.focus.start!==null&&typeof matching.setSelectionRange==='function'&&['text','search','tel','password'].includes(matching.type))matching.setSelectionRange(view.focus.start,view.focus.end);
    } else if(!sameScreen) {
      routeFocus.focus({preventScroll:true});
      announce(entry.title);
    }
  }
  function syncCatalogAccessibility() {
    const modal=matchMedia('(max-width:680px)').matches&&document.querySelector('.review-shell').classList.contains('catalog-open');
    document.querySelector('.review-main').inert=modal;
    const catalogPanel=document.getElementById('screen-catalog');
    if(modal){catalogPanel.setAttribute('role','dialog');catalogPanel.setAttribute('aria-modal','true');}
    else {catalogPanel.removeAttribute('role');catalogPanel.removeAttribute('aria-modal');}
    document.querySelector('.catalog-toggle').setAttribute('aria-expanded',String(modal));
  }
  function renderCatalog(query='') {
    const q=query.toLowerCase().trim();
    document.getElementById('catalog').innerHTML=['Setup','Library','Upload','Sharing','Profile'].map(group=>{
      const entries=catalog.filter(entry=>entry.group===group&&(!q||`${entry.id} ${entry.title} ${entry.group}`.toLowerCase().includes(q)));
      return entries.length?`<section class="catalog-group"><h2>${group}</h2>${entries.map(entry=>`<button type="button" class="catalog-link" data-action="browse-screen" data-target="${entry.id}" ${entry.id===state.screen?'aria-current="page"':''}><span class="catalog-number">${pad(entry.id)}</span><span>${esc(entry.title)}</span></button>`).join('')}</section>`:'';
    }).join('')||'<p class="dialog-copy" style="padding:10px">No matching screens.</p>';
  }
  function toast(message) {
    clearTimeout(toastTimer);const target=document.getElementById('toast');target.textContent=message;target.classList.add('visible');toastTimer=setTimeout(()=>target.classList.remove('visible'),2300);
  }
  function showDialog(title,body,actions=[{label:'Done',action:'close-dialog'}]) {
    if(!dialog.open)dialogReturn={screen:state.screen,focus:describeFocus(document.activeElement)};document.getElementById('dialog-title').textContent=title;document.getElementById('dialog-body').innerHTML=body;
    document.getElementById('dialog-actions').innerHTML=`<div class="dialog-actions">${actions.map((item,i)=>button(item.label,item.action,item.extra||'',item.secondary?'secondary':'primary')).join('')}</div>`;
    if(!dialog.open)dialog.showModal();
    (dialog.querySelector('input,textarea,[aria-pressed="true"],#dialog-body button')||dialog.querySelector('[data-action="close-dialog"]')).focus();
  }
  const copyDialog=(title,copy)=>showDialog(title,`<p class="dialog-copy">${esc(copy)}</p>`);
  const choiceDialog=(title,choices,action)=>showDialog(title,choices.map(label=>button(label,action,`data-value="${esc(label)}"`,'dialog-choice')).join(''),[{label:'Cancel',action:'close-dialog',secondary:true}]);
  function processSetup() {go(8);let ticks=0;progressTimer=setInterval(()=>{if(dialog.open)return;if(++ticks===5){clearInterval(progressTimer);progressTimer=null;go(9,{replace:true,resetTrail:true});}},360);}
  function uploadStart() {
    if(!state.uploadPhotos.size)return;state.uploadProgress=0;go(23);let ticks=0;progressTimer=setInterval(()=>{if(dialog.open)return;state.uploadProgress=Math.min(244,(++ticks)*16);render();if(ticks%4===0)announce(`Upload preview ${Math.round(ticks/16*100)} percent`);if(ticks>=16){clearInterval(progressTimer);progressTimer=null;state.uploadCompleted=true;go(24,{replace:true,resetTrail:true});}},160);
  }
  function shareStart() {
    reconcileShareRecipients();if(!state.selectedPhotos.size||!state.selectedPeople.size)return;state.sharingProgress=0;go(34);progressTimer=setInterval(()=>{if(dialog.open)return;state.sharingProgress++;render();announce(['Preparing sample photos','Finding selected people','Sending sample photos','Share preview complete'][Math.min(state.sharingProgress,3)]);if(state.sharingProgress>=4){clearInterval(progressTimer);progressTimer=null;state.sharedLocally=true;state.history.push({photos:[...state.selectedPhotos],people:[...state.selectedPeople],at:Date.now()});go(35,{replace:true,resetTrail:true});}},480);
  }
  function reset() {if(progressTimer)clearInterval(progressTimer);state=initialState();dialog.close();go(10,{replace:true});window.loveliesPreview.state=state;toast('Demo flow reset');}

  document.addEventListener('click',event=>{
    const target=event.target.closest('[data-action]');if(!target||target.disabled)return;
    const action=target.dataset.action;const id=Number(target.dataset.id);const value=target.dataset.value;const destination=Number(target.dataset.target);
    if(action==='go'){if(destination===22&&!state.uploadPhotos.size)return;go(destination);}
    else if(action==='browse-screen'){go(destination,{referenceState:true});document.querySelector('.review-shell').classList.remove('catalog-open');syncCatalogAccessibility();app.querySelector('h2,[tabindex="-1"]')?.focus({preventScroll:true});}
    else if(action==='previous-screen')go(state.screen-1,{referenceState:true});
    else if(action==='next-screen')go(state.screen+1,{referenceState:true});
    else if(action==='back')back(destination||undefined);
    else if(action==='platform'){state.platform=target.dataset.platform;render();}
    else if(action==='compare'){state.compare=!state.compare;render();}
    else if(action==='catalog-toggle'){
      const open=document.querySelector('.review-shell').classList.toggle('catalog-open');
      syncCatalogAccessibility();
      (open?document.getElementById('catalog-search'):document.querySelector('.catalog-toggle')).focus();
    }
    else if(action==='onboarding'){state.pose=0;go(1);}
    else if(action==='reset')showDialog('Reset demo flow?',`<p class="dialog-copy">Your photo selections, edits and settings will return to their original preview state.</p>`,[{label:'Reset Flow',action:'reset-confirm'},{label:'Keep My Changes',action:'close-dialog',secondary:true}]);
    else if(action==='reset-confirm')reset();
    else if(action==='close-dialog')dialog.close();
    else if(action==='how-it-works'){const copy={matching:'Lovelies matches faces in your photos with the people in them.',people:'Explore your matches and choose who you want to share your memories with.',sharing:'You review the photos and people before anything is shared.'};copyDialog('How Lovelies works',copy[value]);}
    else if(action==='intro-page'){document.querySelectorAll('.page-dots button').forEach(el=>{if(Number(el.dataset.id)===id)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');});const heading=app.querySelector('.intro h2');heading.innerHTML=['Your photos<br>find their people','Find familiar faces<br>in every memory','You choose<br>what to share'][id];}
    else if(action==='auth')showDialog(`Continue with ${value}`,`<p class="dialog-copy">Continue into your Lovelies preview account.</p>`,[{label:'Continue',action:'auth-confirm'},{label:'Cancel',action:'close-dialog',secondary:true}]);
    else if(action==='auth-confirm'){dialog.close();go(4);}
    else if(action==='create-account'||action==='sign-in'){const create=action==='create-account';showDialog(create?'Create your account':'Welcome back',`${create?'<label class="dialog-field">Name<input class="field" type="text" id="auth-name" autocomplete="name" placeholder="Your name" required></label>':''}<label class="dialog-field">Email<input class="field" type="email" id="auth-email" autocomplete="email" placeholder="you@example.com" required></label><label class="dialog-field">Password<input class="field" type="password" id="auth-password" autocomplete="${create?'new-password':'current-password'}" placeholder="Password" minlength="6" required></label>`,[{label:create?'Create Account':'Sign In',action:'auth-form-submit'},{label:'Cancel',action:'close-dialog',secondary:true}]);}
    else if(action==='auth-form-submit'){const email=document.getElementById('auth-email'),password=document.getElementById('auth-password'),name=document.getElementById('auth-name');if(!email.reportValidity()||!password.reportValidity()||(name&&!name.reportValidity()))return;if(name)state.name=name.value.trim();dialog.close();go(4);}
    else if(action==='allow-access'){state.access=value;go(5);}
    else if(action==='access-later'){state.access='limited';go(5);}
    else if(action==='enroll-start'){state.pose=0;go(6);}
    else if(action==='capture'){state.pose++;if(state.pose>=3)processSetup();else render();}
    else if(action==='process-setup')processSetup();
    else if(action==='view-photo'){state.activePhoto=id;state.activePhotoAsset=target.dataset.asset||null;go(12);}
    else if(action==='person-view'){state.activePerson=id;go(28);}
    else if(action==='favorite'){state.favorites.has(id)?state.favorites.delete(id):state.favorites.add(id);render();}
    else if(action==='reference-favorite'){state.referenceSaved.has(id)?state.referenceSaved.delete(id):state.referenceSaved.add(id);state.favorites=new Set(state.referenceSaved);render();}
    else if(action==='select-new-match'){state.newMatchSelections.has(id)?state.newMatchSelections.delete(id):state.newMatchSelections.add(id);render();}
    else if(action==='select-search-result'){state.searchSelections.has(id)?state.searchSelections.delete(id):state.searchSelections.add(id);render();}
    else if(action==='people-from-grid'){state.activePhoto=id;state.activePhotoAsset=target.dataset.asset;go(27);}
    else if(action==='share-one'){state.selectedPhotos=new Set([state.activePhoto]);state.selectionAssets={[state.activePhoto]:activePhotoURL()};go(31);}
    else if(action==='photo-menu')showDialog('Photo Options',`${button('People in this photo','dialog-route','data-target="27"','dialog-choice')}${button('Share this photo','dialog-share-one','','dialog-choice')}${button('Report an incorrect match','dialog-route','data-target="36"','dialog-choice')}${button('View all photos','dialog-route','data-target="13"','dialog-choice')}`,[{label:'Close',action:'close-dialog',secondary:true}]);
    else if(action==='dialog-share-one'){dialog.close();state.selectedPhotos=new Set([state.activePhoto]);state.selectionAssets={[state.activePhoto]:activePhotoURL()};go(31);}
    else if(action==='dialog-route'){dialog.close();go(destination);}
    else if(action==='favorites-menu')showDialog('Favorites',`<p class="dialog-copy">${state.favorites.size} memories saved.</p>${button('Share Favorites','share-favorites','','dialog-choice')}${button('View All Photos','dialog-route','data-target="13"','dialog-choice')}`,[{label:'Done',action:'close-dialog'}]);
    else if(action==='share-favorites'){dialog.close();state.selectedPhotos=new Set(state.favorites);go(31);}
    else if(action==='gallery-layout'){const grid=app.querySelector('.masonry,.source-library-grid');if(grid){const cls=grid.classList.contains('source-library-grid')?'compact-library':'four';grid.classList.toggle(cls);toast(grid.classList.contains(cls)?'Compact photo grid':'Comfortable photo grid');}}
    else if(action==='photo-tab'){state.photoTab=value;render();}
    else if(action==='recent-search'){state.search=value;render();}
    else if(action==='category'){if(value==='Favorites')go(14);else{state.filterCategory=value;go(16);}}
    else if(action==='filter-category'){state.filterCategory=value;render();}
    else if(action==='filter-person'){state.filterPeople.has(id)?state.filterPeople.delete(id):state.filterPeople.add(id);render();}
    else if(action==='filter-add-person')showDialog('Choose a Person',people.slice(3).map(p=>button(p.name,'filter-add-confirm',`data-id="${p.id}"`,'dialog-choice')).join(''),[{label:'Cancel',action:'close-dialog',secondary:true}]);
    else if(action==='filter-add-confirm'){state.filterPeople.add(id);dialog.close();render();toast(`${people[id-1].name} added to filters`);}
    else if(action==='date-filter')choiceDialog('Date Range',['Any date','This week','This month','This year'],'date-confirm');
    else if(action==='date-confirm'){state.dateRange=value;dialog.close();render();}
    else if(action==='location-filter')choiceDialog('Location',['Any location','Italy','Switzerland','By the sea'],'location-confirm');
    else if(action==='location-confirm'){state.location=value;dialog.close();render();}
    else if(action==='media-type'){state.mediaType=value;render();}
    else if(action==='reset-filters'){state.filterCategory='People';state.filterPeople=new Set([1]);state.dateRange='Any date';state.location='Any location';state.mediaType='Photos';state.filtersApplied=false;render();}
    else if(action==='apply-filters'){state.filtersApplied=true;go(state.filterCategory==='Favorites'?14:15);toast('Filters applied');}
    else if(action==='activity-tab'){state.activityTab=value;render();}
    else if(action==='notification-tab'){state.notificationTab=value;render();}
    else if(action==='upload-source'){const cloudSource=cloudSources.find(source=>source.name===value);if(cloudSource?.platform&&cloudSource.platform!==state.platform)return;state.uploadSource=value;if(value==='Albums')choiceDialog('Choose Album',['Travels 2024','Friends','Favorites'],'source-album-confirm');else if(value==='Camera')showDialog('Take a Photo',`<p class="dialog-copy">Use this travel memory as your camera capture.</p><img src="${photoURL(1)}" alt="Camera preview" style="width:100%;max-height:220px;object-fit:cover;border-radius:13px">`,[{label:'Use Photo',action:'source-camera-confirm'},{label:'Cancel',action:'close-dialog',secondary:true}]);else{go(21);if(cloudSource)toast(`${value} preview · sample photos`);}}
    else if(action==='source-album-confirm'){state.album=value;dialog.close();go(21);}
    else if(action==='source-camera-confirm'){state.uploadPhotos=new Set([1]);dialog.close();go(22);}
    else if(action==='select-upload'){state.uploadPhotos.has(id)?state.uploadPhotos.delete(id):state.uploadPhotos.add(id);render();}
    else if(action==='album-picker')choiceDialog('Add to Album',['Travels 2024','Friends','Summer memories','No album'],'album-confirm');
    else if(action==='album-confirm'){state.album=value;dialog.close();render();}
    else if(action==='visibility-picker')choiceDialog('Photo Visibility',['Matched people only','Allowed people only','Only me'],'visibility-confirm');
    else if(action==='visibility-confirm'){state.visibility=value;dialog.close();render();}
    else if(action==='upload-start')uploadStart();
    else if(action==='cancel-upload')showDialog('Cancel Upload?',`<p class="dialog-copy">Your selected photos and caption will stay available to review.</p>`,[{label:'Cancel Upload',action:'cancel-upload-confirm'},{label:'Keep Uploading',action:'close-dialog',secondary:true}]);
    else if(action==='cancel-upload-confirm'){dialog.close();go(22);}
    else if(action==='select-photo'){state.selectedPhotos.has(id)?state.selectedPhotos.delete(id):state.selectedPhotos.add(id);if(target.dataset.asset)state.selectionAssets[id]=target.dataset.asset;state.reviewReferenceFixture=false;render();}
    else if(action==='select-person'){toggleSharePerson(id);render();}
    else if(action==='photo-select-menu')showDialog('Choose Photos',`${button('Select All Photos','select-all-photos','','dialog-choice')}${button('Deselect All Photos','deselect-all-photos','','dialog-choice')}${button('Deselect Photos','dialog-route','data-target="30"','dialog-choice')}`,[{label:'Done',action:'close-dialog'}]);
    else if(action==='select-all-photos'){state.selectedPhotos=new Set(Array.from({length:12},(_,i)=>i+1));state.selectionAssets={...canonicalAssets(29),...state.selectionAssets};state.reviewReferenceFixture=false;dialog.close();render();}
    else if(action==='deselect-all-photos'){state.selectedPhotos.clear();dialog.close();render();}
    else if(action==='people-select-menu')showDialog('Choose People',`${button('Select All People','select-all-people','','dialog-choice')}${button('Deselect All People','deselect-all-people','','dialog-choice')}${button('Deselect People','dialog-route','data-target="32"','dialog-choice')}`,[{label:'Done',action:'close-dialog'}]);
    else if(action==='select-all-people'){state.selectedPeople=new Set(shareablePeople().map(p=>p.id));dialog.close();render();}
    else if(action==='deselect-all-people'){state.selectedPeople.clear();dialog.close();render();}
    else if(action==='matches-menu')showDialog('Matched Photos',`${button('Select Photos to Share','dialog-route','data-target="29"','dialog-choice')}${button('Report Incorrect Match','dialog-route','data-target="36"','dialog-choice')}`,[{label:'Done',action:'close-dialog'}]);
    else if(action==='people-photo-menu'||action==='person-menu')showDialog('People & Matches',`${button('Select Photos to Share','dialog-route','data-target="29"','dialog-choice')}${button('Report Incorrect Match','dialog-route','data-target="36"','dialog-choice')}${button('Manage Allowed People','dialog-route','data-target="39"','dialog-choice')}`,[{label:'Done',action:'close-dialog'}]);
    else if(action==='show-all-people')showDialog('People in This Photo',people.map(p=>`<button type="button" class="person-select-row" data-action="dialog-person" data-id="${p.id}">${avatar(p.id)}<span class="row-main"><strong>${p.name}</strong></span><span class="chevron">›</span></button>`).join(''),[{label:'Done',action:'close-dialog'}]);
    else if(action==='dialog-person'){dialog.close();state.activePerson=id;go(28);}
    else if(action==='share-start')shareStart();
    else if(action==='history-menu')showDialog('Shared History',`<p class="dialog-copy">Review your recent shared photos and the people you chose.</p>${button('Share More Photos','dialog-route','data-target="29"','dialog-choice')}${button('Manage People','dialog-route','data-target="39"','dialog-choice')}`,[{label:'Done',action:'close-dialog'}]);
    else if(action==='submit-report'){state.reportSubmitted=true;render();toast('Thank you. Your match report is saved.');}
    else if(action==='report-help')copyDialog('Incorrect Matches','Choose the reason that best describes the issue. Reporting a match helps you keep your photo library accurate.');
    else if(action==='profile-tab'){state.profileTab=value;render();}
    else if(action==='profile-menu')showDialog('Profile & Settings',[[38,'Manage Your Face'],[39,'Manage People'],[40,'Privacy & Sharing'],[41,'Photo Access'],[42,'Notifications'],[43,'Storage'],[44,'Export Your Data'],[45,'Help Center'],[46,'Account & Security']].map(([destination,title])=>button(title,'dialog-route',`data-target="${destination}"`,'dialog-choice')).join(''),[{label:'Done',action:'close-dialog'}]);
    else if(action==='edit-profile')showDialog('Edit Profile',`<label class="dialog-field">Name<input type="text" class="field" id="profile-name" autocomplete="name" required value="${esc(state.name)}"></label><label class="dialog-field">About you<textarea class="field" id="profile-bio" rows="3" maxlength="140">${esc(state.bio)}</textarea></label>`,[{label:'Save Changes',action:'save-profile'},{label:'Cancel',action:'close-dialog',secondary:true}]);
    else if(action==='save-profile'){const input=document.getElementById('profile-name');if(!input.reportValidity())return;state.name=input.value.trim();state.bio=document.getElementById('profile-bio').value;dialog.close();render();toast('Profile updated');}
    else if(action==='face-variant'){state.faceVariant=id;render();toast(`Selfie ${id} selected`);}
    else if(action==='replace-face')showDialog('Replace Your Face?',`<p class="dialog-copy">Take three new selfies to update your face matches.</p>`,[{label:'Take New Selfies',action:'replace-face-confirm'},{label:'Cancel',action:'close-dialog',secondary:true}]);
    else if(action==='replace-face-confirm'){dialog.close();state.pose=0;go(6);}
    else if(action==='face-tips')showDialog('Tips for Best Results','<ul class="dialog-list"><li>Use bright, even light.</li><li>Keep your face centered and in focus.</li><li>Remove sunglasses and keep your face clear.</li><li>Follow all three selfie poses.</li></ul>');
    else if(action==='recipient-tab'){state.recipientTab=value;render();}
    else if(action==='manage-recipient'){const person=recipients.find(person=>person.id===id);if(!person)return;const blocked=state.blocked.has(id);const matched=matchedRecipients.some(person=>person.id===id);showDialog(person.name,`<p class="dialog-copy">${blocked?`${matched?'Unblocking makes this matched person eligible for future shares.':'Unblocking makes this person eligible for future shares if you match again.'} Previous access is not restored automatically.`:'You can choose this matched person when reviewing a share. Blocking removes them from your current selection and future shares.'}</p>`,[{label:blocked?'Unblock':'Block',action:'recipient-confirm',extra:`data-id="${id}" data-block="${!blocked}"`},{label:'Cancel',action:'close-dialog',secondary:true}]);}
    else if(action==='recipient-confirm'){if(!recipients.some(person=>person.id===id))return;if(target.dataset.block==='true'){state.blocked.add(id);state.selectedPeople.delete(id);}else state.blocked.delete(id);dialog.close();render();}
    else if(action==='find-privacy')showDialog('Who Can Find You',`<p class="dialog-copy">Choose who can discover your profile. Photo visibility and sharing approval stay separate.</p><div class="discoverability-options" role="group" aria-label="Who can find you">${[['Anyone','Anyone'],['Only matched people','Only people you’re matched with'],['Allowed people only','Allowed people only']].map(([label,setting])=>`<button type="button" class="dialog-choice privacy-choice" data-action="find-privacy-confirm" data-value="${esc(label)}" aria-pressed="${state.findable===setting}"><span>${esc(label)}</span><span class="choice-marker" aria-hidden="true">${state.findable===setting?icon('check'):''}</span></button>`).join('')}</div>`,[{label:'Cancel',action:'close-dialog',secondary:true}]);
    else if(action==='find-privacy-confirm'){state.findable=value==='Only matched people'?'Only people you’re matched with':value;dialog.close();render();toast('Discoverability updated');}
    else if(action==='save-access'){go(37);toast('Photo access updated');}
    else if(action==='manage-storage')showDialog('Manage Storage',`<p class="dialog-copy">${state.cacheCleared?'Your cache is clear.':'Clear 180 MB of cached previews. Your photos and matches stay in your library.'}</p>`,[{label:state.cacheCleared?'Done':'Clear Cache',action:state.cacheCleared?'close-dialog':'clear-cache'},{label:'Back',action:'close-dialog',secondary:true}]);
    else if(action==='clear-cache'){state.cacheCleared=true;dialog.close();render();toast('Cache cleared');}
    else if(action==='request-export')showDialog('Request Your Export',`<p class="dialog-copy">Prepare a copy of your photos, matches, profile and preferences.</p>`,[{label:'Request Export',action:'export-confirm'},{label:'Cancel',action:'close-dialog',secondary:true}]);
    else if(action==='export-confirm'){state.exported=true;dialog.close();render();toast('Your export request is saved');}
    else if(action==='help-topic'){const topic=helpTopics[id];if(id===5)showDialog('Contact Support','<label class="dialog-field">What can we help with?<textarea class="field" id="support-message" rows="4" required placeholder="Tell us what happened…"></textarea></label>',[{label:'Save Request',action:'support-save'},{label:'Cancel',action:'close-dialog',secondary:true}]);else copyDialog(topic[1],topic[3]);}
    else if(action==='support-save'){if(!document.getElementById('support-message').reportValidity())return;dialog.close();toast('Support request saved in this preview');}
    else if(action==='security-email'||action==='security-phone'||action==='security-password'){const type=action.split('-')[1];showDialog(`Update ${type.charAt(0).toUpperCase()+type.slice(1)}`,`<label class="dialog-field">New ${type}<input type="${type==='email'?'email':type==='phone'?'tel':'password'}" id="security-value" data-detail="${type}" class="field" value="${type==='password'?'':esc(state[type])}" required ${type==='password'?'minlength="6"':''}></label>`,[{label:'Save',action:'security-value-save'},{label:'Cancel',action:'close-dialog',secondary:true}]);}
    else if(action==='security-value-save'){const input=document.getElementById('security-value');if(!input.reportValidity())return;if(input.dataset.detail!=='password')state[input.dataset.detail]=input.value.trim();dialog.close();render();toast('Account detail updated');}
    else if(action==='security-2fa')showDialog('Two-Factor Authentication',`<p class="dialog-copy">Add another check when you sign in to your account.</p>`,[{label:state.twoFactor?'Turn Off':'Turn On',action:'security-2fa-confirm'},{label:'Cancel',action:'close-dialog',secondary:true}]);
    else if(action==='security-2fa-confirm'){state.twoFactor=!state.twoFactor;dialog.close();render();}
    else if(action==='security-devices')showDialog('Active Devices',`${[['This iPhone','Current device'],['Android phone','Last active yesterday'],['MacBook','Last active 3 days ago']].slice(0,state.devices).map(([name,last],i)=>`<div class="dialog-row"><div><strong>${name}</strong><br><small>${last}</small></div>${i?button('Remove','remove-device',`data-id="${i}"`,''):'<small>Active</small>'}</div>`).join('')}`);
    else if(action==='remove-device'){state.devices=Math.max(1,state.devices-1);dialog.close();render();toast('Device removed');}
    else if(action==='sign-out')showDialog('Sign Out?',`<p class="dialog-copy">Your saved preview photos and profile remain available.</p>`,[{label:'Sign Out',action:'sign-out-confirm'},{label:'Stay Signed In',action:'close-dialog',secondary:true}]);
    else if(action==='sign-out-confirm'){state.signedOut=true;dialog.close();go(3);}
    else if(action==='delete-account')showDialog('Delete Your Account?',`<p class="dialog-copy">This resets your account and selections in the clickable preview.</p>`,[{label:'Delete Preview Account',action:'delete-account-confirm'},{label:'Keep Account',action:'close-dialog',secondary:true}]);
    else if(action==='delete-account-confirm'){dialog.close();state=initialState();window.loveliesPreview.state=state;go(1);}
    else if(action==='retry-connection'){go(10);toast('Your library is ready');}
    else if(action==='info')copyDialog(target.textContent.trim(),'Review and manage this setting in your Lovelies profile.');
  });
  document.addEventListener('input',event=>{
    const target=event.target;
    if(target.id==='catalog-search')renderCatalog(target.value);
    if(target.dataset.input==='photo-search'){state.search=target.value;document.getElementById('photo-results').innerHTML=searchResults();document.getElementById('search-result-heading').textContent=state.search?'Search results':'Results';clearTimeout(searchAnnouncementTimer);searchAnnouncementTimer=setTimeout(()=>announce(`${document.querySelectorAll('#photo-results button.photo').length} photo results`),400);}
    if(target.dataset.input==='caption')state.caption=target.value;
    if(target.dataset.input==='help-search'){state.helpSearch=target.value;document.getElementById('help-results').innerHTML=`<div class="list-group">${helpRows()}</div>`;clearTimeout(searchAnnouncementTimer);searchAnnouncementTimer=setTimeout(()=>announce(`${document.querySelectorAll('#help-results button').length} help topics`),400);}
  });
  document.addEventListener('change',event=>{
    const target=event.target;const setting=target.dataset.setting;
    if(setting==='access'){state.access=target.value;render();}
    else if(setting==='reportReason'){state.reportReason=target.value;render();}
    else if(setting==='privacy'||setting==='notifications'){state[setting][target.dataset.key]=target.checked;}
  });
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  window.addEventListener('popstate',event=>{const nextPosition=event.state?.position??0;const direction=nextPosition<historyPosition?'back':'forward';historyPosition=nextPosition;go(parseHash(),{fromHistory:true,referenceState:!event.state?.lovelies,trail:event.state?.trail||[],direction});});
  window.addEventListener('hashchange',()=>{const id=parseHash();if(id!==state.screen)go(id,{fromHistory:true,referenceState:true});});
  dialog.querySelector('form').addEventListener('submit',event=>{event.preventDefault();dialog.querySelector('#dialog-actions .primary')?.click();});
  dialog.addEventListener('close',()=>{
    if(dialogReturn?.screen===state.screen&&!dialog.open)findFocus(dialogReturn.focus)?.focus({preventScroll:true});
    dialogReturn=null;
  });
  window.addEventListener('resize',syncCatalogAccessibility);
  document.addEventListener('keydown',event=>{
    if(event.key==='Tab'&&document.querySelector('.review-main').inert){
      const controls=[...document.querySelectorAll('#screen-catalog button,#screen-catalog input,#screen-catalog a')].filter(el=>el.getClientRects().length);
      const first=controls[0],last=controls.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    }
    if(event.key==='Escape'&&!dialog.open&&document.querySelector('.review-shell.catalog-open')){
      document.querySelector('.review-shell').classList.remove('catalog-open');
      syncCatalogAccessibility();
      document.querySelector('.catalog-toggle').focus();
    }
  });
  function parseHash(){const match=location.hash.match(/(?:screen=|#)(\d+)/);return match?Number(match[1]):10;}
  window.loveliesPreview={go:(id,options={referenceState:true})=>go(id,options),reset,state,get screen(){return state.screen},get catalog(){return catalog},get referenceLayouts(){return referenceLayouts},selectPhoto(id){state.selectedPhotos.has(id)?state.selectedPhotos.delete(id):state.selectedPhotos.add(id);state.selectionAssets[id]??=canonicalAssets(29)[id];state.reviewReferenceFixture=false;render();},selectPerson(id){toggleSharePerson(id);render();}};
  Promise.allSettled([
    fetch('../shared/catalog.json').then(response=>{if(!response.ok)throw new Error('Catalogue unavailable');return response.json();}),
    fetch('../shared/home-grid.json').then(response=>{if(!response.ok)throw new Error('Home layout unavailable');return response.json();}),
    fetch('../shared/reference-grids/layouts.json').then(response=>{if(!response.ok)throw new Error('Reference layouts unavailable');return response.json();})
  ]).then(([catalogResult,homeResult,gridResult])=>{
    if(catalogResult.status==='fulfilled'&&Array.isArray(catalogResult.value)&&catalogResult.value.length===48)catalog=catalogResult.value;
    if(homeResult.status==='fulfilled'&&Array.isArray(homeResult.value.tiles)&&homeResult.value.tiles.length===16)homeTiles=homeResult.value.tiles;
    if(gridResult.status==='fulfilled'&&gridResult.value&&typeof gridResult.value==='object')referenceLayouts=gridResult.value;
    state.selectionAssets=canonicalAssets(29);
    renderCatalog();go(parseHash(),{referenceState:true,replace:true});
  });
})();
