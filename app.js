const STORAGE_KEY = 'coupleBudget_v1';

const LOCAL_DELETE_KEY='coupleBudget_local_delete_tombstones_v1';
const LOCAL_DELETE_TTL_MS=Number.POSITIVE_INFINITY;
function loadLocalDeleteTombstones(){
  try{
    const raw=JSON.parse(localStorage.getItem(LOCAL_DELETE_KEY)||'{}');
    const now=Date.now(),out={};
    Object.entries(raw||{}).forEach(([k,v])=>{if(now-Number(v||0)<LOCAL_DELETE_TTL_MS)out[k]=Number(v);});
    localStorage.setItem(LOCAL_DELETE_KEY,JSON.stringify(out));
    return out;
  }catch{return {};}
}
let localDeleteTombstones=loadLocalDeleteTombstones();
function deleteTombstoneKey(entity,idValue){return `${entity}::${String(idValue)}`;}
function markLocalDeleted(entity,idValue){
  const key=deleteTombstoneKey(entity,idValue);
  localDeleteTombstones[key]=Date.now();
  localStorage.setItem(LOCAL_DELETE_KEY,JSON.stringify(localDeleteTombstones));
  if(pendingUpserts[key]){delete pendingUpserts[key];savePendingUpserts();}
  queuePendingDelete(entity,idValue);
}
function isLocallyDeleted(entity,idValue){
  const k=deleteTombstoneKey(entity,idValue),t=Number(localDeleteTombstones[k]||0);
  if(!t)return false;
  if(Date.now()-t>=LOCAL_DELETE_TTL_MS){
    delete localDeleteTombstones[k];
    localStorage.setItem(LOCAL_DELETE_KEY,JSON.stringify(localDeleteTombstones));
    return false;
  }
  return true;
}


const PENDING_UPSERT_KEY='coupleBudget_pending_upserts_v1';
function loadPendingUpserts(){
  try{
    const raw=JSON.parse(localStorage.getItem(PENDING_UPSERT_KEY)||'{}');
    return raw&&typeof raw==='object'?raw:{};
  }catch{return {};}
}
let pendingUpserts=loadPendingUpserts();
function savePendingUpserts(){
  localStorage.setItem(PENDING_UPSERT_KEY,JSON.stringify(pendingUpserts));
}
function queuePendingUpserts(entity,records){
  (records||[]).forEach(record=>{
    if(!record||!record.id)return;
    const key=deleteTombstoneKey(entity,record.id);
    pendingUpserts[key]={entity:String(entity),record:structuredClone(record),queuedAt:Date.now(),tries:Number((pendingUpserts[key]||{}).tries||0)};
  });
  savePendingUpserts();
}
async function remoteUpsertRecords(entity,records){
  if(!apiConfigured())return {ok:false,acceptedCount:0,count:(records||[]).length};
  const payload=btoa(unescape(encodeURIComponent(JSON.stringify({entity:String(entity),records:records||[]}))));
  const res=await jsonpRequest({action:'upsertRecords',payload64:payload});
  if(!res||!res.ok)throw new Error((res&&res.error)||'행 저장 실패');
  return {
    ok:true,
    count:Number(res.count)||0,
    acceptedCount:Number(res.acceptedCount ?? res.count)||0
  };
}
let flushingUpserts=false;
async function flushPendingUpserts(opts={}){
  if(flushingUpserts||!apiConfigured())return false;
  const entries=Object.entries(pendingUpserts||{});
  if(!entries.length)return true;
  flushingUpserts=true;
  let allOk=true;
  try{
    const groups={};
    entries.forEach(([key,item])=>{
      if(!groups[item.entity])groups[item.entity]=[];
      groups[item.entity].push([key,item]);
    });
    for(const [entity,items] of Object.entries(groups)){
      try{
        const result=await remoteUpsertRecords(entity,items.map(([,item])=>item.record));
        // rejected rows are normally IDs that were already tombstoned on another device.
        // They must not be retried into resurrection.
        items.forEach(([key])=>delete pendingUpserts[key]);
        savePendingUpserts();
        if(result.acceptedCount<result.count){
          console.info('서버 삭제 상태가 우선되어 일부 로컬 변경을 폐기했습니다.',entity,result);
        }
      }catch(err){
        allOk=false;
        items.forEach(([key,item])=>{
          if(pendingUpserts[key]){
            pendingUpserts[key].tries=Number(item.tries||0)+1;
            pendingUpserts[key].lastTry=Date.now();
          }
        });
        savePendingUpserts();
        console.warn('저장 재시도 대기',entity,err);
      }
    }
    if(!allOk&&!opts.quiet)setSyncStatus('일부 변경사항 동기화 대기 중 · 자동 재시도',false);
    return allOk;
  }finally{
    flushingUpserts=false;
  }
}
async function flushPendingMutations(opts={}){
  const u=await flushPendingUpserts(opts);
  const d=await flushPendingDeletes(opts);
  return u&&d;
}

const PENDING_DELETE_KEY='coupleBudget_pending_deletes_v1';
function loadPendingDeletes(){
  try{
    const raw=JSON.parse(localStorage.getItem(PENDING_DELETE_KEY)||'{}');
    return raw&&typeof raw==='object'?raw:{};
  }catch{return {};}
}
let pendingDeletes=loadPendingDeletes();

function savePendingDeletes(){
  localStorage.setItem(PENDING_DELETE_KEY,JSON.stringify(pendingDeletes));
}
function queuePendingDelete(entity,idValue){
  const key=deleteTombstoneKey(entity,idValue);
  pendingDeletes[key]={entity:String(entity),id:String(idValue),queuedAt:Date.now(),tries:Number((pendingDeletes[key]||{}).tries||0)};
  savePendingDeletes();
}
function seedPendingDeletesFromLocalTombstones(){
  Object.keys(localDeleteTombstones||{}).forEach(key=>{
    if(pendingDeletes[key])return;
    const p=key.indexOf('::');
    if(p<1)return;
    pendingDeletes[key]={entity:key.slice(0,p),id:key.slice(p+2),queuedAt:Number(localDeleteTombstones[key]||Date.now()),tries:0};
  });
  savePendingDeletes();
}
seedPendingDeletesFromLocalTombstones();

let flushingDeletes=false;
async function flushPendingDeletes(opts={}){
  if(flushingDeletes||!apiConfigured())return false;
  const entries=Object.entries(pendingDeletes||{});
  if(!entries.length)return true;
  flushingDeletes=true;
  if(!opts.quiet)setSyncStatus(`삭제 ${entries.length}건 동기화 중…`);
  let allOk=true;
  try{
    for(const [key,item] of entries){
      try{
        const res=await jsonpRequest({action:'deleteRecord',entity:item.entity,id:item.id});
        if(!res||!res.ok)throw new Error((res&&res.error)||'삭제 동기화 실패');
        delete pendingDeletes[key];
        savePendingDeletes();
        if(localDeleteTombstones[key]){
          delete localDeleteTombstones[key];
          localStorage.setItem(LOCAL_DELETE_KEY,JSON.stringify(localDeleteTombstones));
        }
      }catch(err){
        allOk=false;
        if(pendingDeletes[key]){
          pendingDeletes[key].tries=Number(pendingDeletes[key].tries||0)+1;
          pendingDeletes[key].lastTry=Date.now();
          savePendingDeletes();
        }
        console.warn('삭제 재시도 대기',item,err);
      }
    }
    if(!allOk&&!opts.quiet)setSyncStatus('일부 삭제 동기화 대기 중 · 자동 재시도',false);
    return allOk;
  }finally{
    flushingDeletes=false;
  }
}


const today = new Date();
const pad = n => String(n).padStart(2,'0');
const currentMonth = `${today.getFullYear()}-${pad(today.getMonth()+1)}`;
const todayStr = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;

const defaultState = {
  settings: {
    variableCategories: ['고정','생활비','식비','이벤트'],
    eventCategories: ['경조사','병원','교회','여가','가구가전'],
    methods: ['현금','아내카드','남편카드'],
    husbandCards: ['현대','국민','신한'],
    wifeCards: ['국민','현대','BC'],
    brandIcon: '₩',
    brandTitle: '우리집 가계부',
    brandSubtitle: 'Couple Budget',
    incomeCategories: ['남편','아내','자녀','공통'],
    fixedCategories: ['주거','보험','헌금'],
    entryTabBehavior: 'remember'
  },
  variableExpenses: [],
  incomes: {},
  fixedExpenses: {},
  monthlyLimits: {},
  cardRecords: []
};

let state = loadState();
let selectedMonth = currentMonth;
let activePage = 'add';
let detailsSortMode = 'latest';
let incomeSortMode = 'category';
let fixedSortMode = 'category';
let expandedSummaryMonth = '';
let expandedSummaryCategory = '';
const API_URL = (window.BUDGET_CONFIG && window.BUDGET_CONFIG.API_URL) || '';
let PIN_HASH = (window.BUDGET_CONFIG && window.BUDGET_CONFIG.PIN_HASH) || '';
const DEFAULT_PIN_HASH = PIN_HASH;
const APP_VERSION = 'v34.0 · 2026-08-30';
const PIN_SESSION_KEY = 'coupleBudget_pin_ok_v1';
const PIN_CACHE_KEY = 'coupleBudget_pin_hash_cache_v1';
const cachedPinHash = localStorage.getItem(PIN_CACHE_KEY) || '';
if(cachedPinHash) PIN_HASH=cachedPinHash;
let syncing = false;
let pendingSave = false;
let formDirty = false;
let expenseDraft = null;
function snapshotExpenseDraft(form){
  if(!form) return;
  const f=new FormData(form);
  expenseDraft={
    categoryChoice:String(f.get('categoryChoice')||''),
    amount:String(f.get('amount')||''),
    date:String(f.get('date')||''),
    method:String(f.get('method')||''),
    memo:String(f.get('memo')||''),
    reimbursedAmount:String(f.get('reimbursedAmount')||''),
    installmentCount:String(f.get('installmentCount')||'1')
  };
  formDirty=true;
}
function clearExpenseDraft(){ expenseDraft=null; }
const THEME_KEY = 'coupleBudget_theme_v1';
let uiTheme = localStorage.getItem(THEME_KEY) || 'current';
function applyTheme(theme){ uiTheme = theme==='lovable'?'lovable':'current'; localStorage.setItem(THEME_KEY,uiTheme); document.body.dataset.theme=uiTheme; }
applyTheme(uiTheme);

async function sha256(text){
  const data = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function unlockApp(){
  sessionStorage.setItem(PIN_SESSION_KEY,'1');
  const gate=document.getElementById('pinGate');
  if(gate){ gate.classList.remove('show'); gate.setAttribute('aria-hidden','true'); }
  document.body.classList.remove('locked','pin-pending');
}
function lockApp(){
  const gate=document.getElementById('pinGate');
  if(!gate) return;
  document.body.classList.add('locked','pin-pending');
  gate.classList.add('show');
  gate.setAttribute('aria-hidden','false');
  setTimeout(()=>{ const input=document.getElementById('pinInput'); if(input) input.focus(); },50);
}
function jsonpRequest(params){
  return new Promise((resolve,reject)=>{
    if(!apiConfigured()) return reject(new Error('API not configured'));
    const cb='budgetCb_'+Date.now()+'_'+Math.random().toString(36).slice(2);
    const sc=document.createElement('script');
    const timer=setTimeout(()=>{ cleanup(); reject(new Error('연결 시간 초과')); },12000);
    const cleanup=()=>{ clearTimeout(timer); try{delete window[cb]}catch(e){}; sc.remove(); };
    window[cb]=(res)=>{ cleanup(); resolve(res); };
    sc.onerror=()=>{ cleanup(); reject(new Error('연결 실패')); };
    const qs=new URLSearchParams({...params, callback:cb, _:Date.now()});
    sc.src=API_URL+'?'+qs.toString();
    document.head.appendChild(sc);
  });
}
async function refreshPinHash(){
  if(!apiConfigured()) return PIN_HASH;
  try{
    const res=await jsonpRequest({action:'getPinConfig'});
    if(res && res.ok && res.pinHash){ PIN_HASH=res.pinHash; localStorage.setItem(PIN_CACHE_KEY,PIN_HASH); }
  }catch(err){ console.warn('PIN 설정 불러오기 실패, config.js 기본값 사용',err); }
  return PIN_HASH;
}
async function initPinGate(){
  const form=document.getElementById('pinForm');
  const input=document.getElementById('pinInput');
  const error=document.getElementById('pinError');

  if(sessionStorage.getItem(PIN_SESSION_KEY)==='1'){
    unlockApp();
    refreshPinHash();
    remoteLoad();
    return;
  }

  lockApp();

  form.onsubmit=async(ev)=>{
    ev.preventDefault();
    const h=await sha256(input.value||'');
    if(PIN_HASH && h===PIN_HASH){
      error.textContent='';
      input.value='';
      unlockApp();
      remoteLoad();
      refreshPinHash();
      return;
    }
    await refreshPinHash();
    if(PIN_HASH && h===PIN_HASH){
      error.textContent='';
      input.value='';
      unlockApp();
      remoteLoad();
    } else {
      error.textContent='PIN이 올바르지 않습니다.';
      input.select();
    }
  };

  input.addEventListener('keydown',ev=>{
    if(ev.key==='Enter'){
      ev.preventDefault();
      if(form.requestSubmit) form.requestSubmit();
      else form.dispatchEvent(new Event('submit',{cancelable:true}));
    }
  });

  // 서버 확인은 백그라운드에서 수행해 PIN 입력 자체를 막지 않습니다.
  refreshPinHash().then(()=>{
    if(!PIN_HASH){ unlockApp(); remoteLoad(); }
  });
}

async function changeSharedPin(currentPin,newPin){
  const currentHash=await sha256(currentPin);
  if(currentHash!==PIN_HASH) throw new Error('현재 PIN이 올바르지 않습니다.');
  const newHash=await sha256(newPin);
  if(!/^\d{4,12}$/.test(newPin)) throw new Error('새 PIN은 숫자 4~12자리로 입력해 주세요.');
  await fetch(API_URL,{method:'POST',mode:'no-cors',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action:'setPinHash',payload:{pinHash:newHash,currentHash:currentHash}})});
  PIN_HASH=newHash;
  return true;
}


function apiConfigured(){ return /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/.test(API_URL); }

function pendingMutationCount(){
  return Object.keys(pendingUpserts||{}).length+Object.keys(pendingDeletes||{}).length;
}
function setSyncStatus(text, ok=true){
  const el=document.getElementById('syncStatus');
  const retry=document.getElementById('retrySyncBtn');
  if(el){
    el.textContent=text;
    const host=el.closest('.sidebar-foot');
    if(host)host.classList.toggle('sync-error',!ok);
  }
  if(retry)retry.hidden=ok;
}

function pendingUpsertRecordsByEntity(entity){
  return Object.values(pendingUpserts||{})
    .filter(item=>item&&item.entity===entity&&item.record)
    .map(item=>structuredClone(item.record));
}
function applyPendingUpsertsToGrouped(grouped,entity){
  const out=normalizeGroupedMonths(grouped||{});
  pendingUpsertRecordsByEntity(entity).forEach(rec=>{
    const month=normalizeMonthKey(rec.month);
    if(!month)return;
    const arr=out[month]||[];
    const i=arr.findIndex(x=>String(x.id)===String(rec.id));
    if(i>=0)arr[i]={...arr[i],...rec,month};
    else arr.push({...rec,month});
    out[month]=arr;
  });
  return out;
}
function reconcileServerState(remoteState){
  // 서버가 확정 상태의 기준이다.
  // 로컬에서 서버 확인을 아직 못 받은 outbox 항목만 서버 상태 위에 다시 적용한다.
  const next=normalizeStateModel({...structuredClone(defaultState),...(remoteState||{})});

  pendingUpsertRecordsByEntity('variableExpenses').forEach(rec=>{
    const i=next.variableExpenses.findIndex(x=>String(x.id)===String(rec.id));
    if(i>=0)next.variableExpenses[i]={...next.variableExpenses[i],...rec};
    else next.variableExpenses.push({...rec});
  });

  pendingUpsertRecordsByEntity('cardRecords').forEach(rec=>{
    const i=next.cardRecords.findIndex(x=>String(x.id)===String(rec.id));
    if(i>=0)next.cardRecords[i]={...next.cardRecords[i],...rec};
    else next.cardRecords.push({...rec});
  });

  next.incomes=applyPendingUpsertsToGrouped(next.incomes,'incomes');
  next.fixedExpenses=applyPendingUpsertsToGrouped(next.fixedExpenses,'fixedExpenses');

  // 삭제 대기 중인 항목은 서버가 아직 응답하지 않았더라도 화면에서 계속 숨긴다.
  next.variableExpenses=(next.variableExpenses||[]).filter(x=>!isLocallyDeleted('variableExpenses',x.id));
  next.cardRecords=(next.cardRecords||[]).filter(x=>!isLocallyDeleted('cardRecords',x.id));
  Object.keys(next.incomes||{}).forEach(m=>{
    next.incomes[m]=(next.incomes[m]||[]).filter(x=>!isLocallyDeleted('incomes',x.id));
  });
  Object.keys(next.fixedExpenses||{}).forEach(m=>{
    next.fixedExpenses[m]=(next.fixedExpenses[m]||[]).filter(x=>!isLocallyDeleted('fixedExpenses',x.id));
  });

  return normalizeStateModel(next);
}

function remoteLoad(){
  flushPendingMutations({quiet:true}).catch(()=>{});
  if(formDirty){ setSyncStatus('입력 중 · 자동 동기화 잠시 멈춤'); return Promise.resolve(false); }
  if(!apiConfigured()){ setSyncStatus('설정 필요: config.js에 Apps Script 주소 입력', false); return Promise.resolve(false); }
  return new Promise((resolve,reject)=>{
    const cb='budgetCb_'+Date.now()+'_'+Math.random().toString(36).slice(2);
    const sc=document.createElement('script');
    const timer=setTimeout(()=>{ cleanup(); reject(new Error('연결 시간 초과')); },12000);
    const cleanup=()=>{ clearTimeout(timer); try{delete window[cb]}catch{}; sc.remove(); };
    window[cb]=(res)=>{ cleanup(); if(res && res.ok && res.data){ state=reconcileServerState(res.data); localStorage.setItem(STORAGE_KEY,JSON.stringify(state)); setSyncStatus(pendingMutationCount()?`Google Sheets 동기화됨 · ${pendingMutationCount()}건 전송 대기`:'Google Sheets 동기화됨'); if(!formDirty)render(); resolve(true); } else { reject(new Error((res&&res.error)||'불러오기 실패')); } };
    sc.onerror=()=>{ cleanup(); reject(new Error('연결 실패')); };
    sc.src=API_URL+'?action=getState&callback='+encodeURIComponent(cb)+'&_='+Date.now();
    document.head.appendChild(sc);
  }).catch(err=>{ setSyncStatus('동기화 오류 · 로컬 데이터 표시 중',false); console.error(err); return false; });
}
function remoteSave(){
  if(!apiConfigured()) return;
  if(syncing){ pendingSave=true; return; }
  syncing=true; pendingSave=false; setSyncStatus('Google Sheets 저장 중…');
  const snapshot=structuredClone(state);
  fetch(API_URL,{method:'POST',mode:'no-cors',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action:'mergeState',payload:snapshot})})
    .then(()=>{setSyncStatus('Google Sheets 저장 요청됨');})
    .catch(err=>{setSyncStatus('저장 오류 · 로컬에는 저장됨',false); console.error(err);})
    .finally(()=>{
      syncing=false;
      if(pendingSave) remoteSave();
    });
}


function remoteSaveSettings(){
  if(!apiConfigured()) return Promise.resolve(false);
  const snapshot=structuredClone(state.settings||{});
  setSyncStatus('설정 저장 중…');
  return fetch(API_URL,{
    method:'POST',mode:'no-cors',
    headers:{'Content-Type':'text/plain;charset=utf-8'},
    body:JSON.stringify({action:'saveSettings',payload:snapshot})
  }).then(()=>{setSyncStatus('설정 저장됨');return true;})
    .catch(err=>{setSyncStatus('설정 저장 오류',false);console.error(err);return false;});
}
function saveSettingsState(withData=false){
  saveLocalOnly();
  remoteSaveSettings();
  if(withData) remoteSave();
}


async function remoteDeleteRecord(entity,idValue){
  if(!apiConfigured()) return false;
  const res=await jsonpRequest({action:'deleteRecord',entity:String(entity),id:String(idValue)});
  if(!res||!res.ok) throw new Error((res&&res.error)||'삭제 동기화 실패');
  return true;
}


const ENTRY_TAB_PREF_KEY='coupleBudget_entry_tab_prefs_v1';
function loadEntryTabPrefs(){
  try{
    const x=JSON.parse(localStorage.getItem(ENTRY_TAB_PREF_KEY)||'{}');
    return x&&typeof x==='object'?x:{};
  }catch{return {};}
}
let entryTabPrefs=loadEntryTabPrefs();
function rememberEntryTab(key,value){
  if(!key||value===undefined||value===null||value==='')return;
  entryTabPrefs[key]=String(value);
  localStorage.setItem(ENTRY_TAB_PREF_KEY,JSON.stringify(entryTabPrefs));
}
function preferredEntryTab(key,options){
  const arr=(options||[]).map(String);
  if((state.settings&&state.settings.entryTabBehavior)==='first') return arr[0]||'';
  const saved=String(entryTabPrefs[key]||'');
  return saved&&arr.includes(saved)?saved:(arr[0]||'');
}

const pages = [
  ['add','＋','지출 등록','지출을 빠르게 기록하고 이번 달 잔액을 확인하세요.'],
  ['details','≡','변동지출','등록된 지출을 날짜·분류·결제수단별로 확인하세요.'],
  ['fixed','⌂','기본지출','현금으로 나가는 월별 고정지출을 관리하세요.'],
  ['income','↗','월별 수입','월별 수입 항목을 등록하고 관리하세요.'],
  ['summary','▦','연간 요약','한 해의 수입과 지출 흐름을 간단히 확인하세요.'],
  ['cards','▤','카드 청구 기록','해당 월에 청구된 카드 금액을 카드별로 기록하세요.'],
  ['settings','⚙','설정','가계부 항목과 화면 표시를 관리하세요.']
];

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const pageTitle = document.getElementById('pageTitle');
const pageSubtitle = document.getElementById('pageSubtitle');
const globalMonth = document.getElementById('globalMonth');
const currentMonthBtn = document.getElementById('currentMonthBtn');
const prevMonthBtn = document.getElementById('prevMonthBtn');
const nextMonthBtn = document.getElementById('nextMonthBtn');
const retrySyncBtn = document.getElementById('retrySyncBtn');
if(retrySyncBtn)retrySyncBtn.onclick=async()=>{
  retrySyncBtn.disabled=true;
  setSyncStatus('재동기화 중…');
  try{
    await flushPendingMutations();
    const ok=await remoteLoad();
    toast(ok?'서버 데이터를 다시 불러왔습니다.':'서버 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.');
  }finally{
    retrySyncBtn.disabled=false;
  }
};
globalMonth.value = selectedMonth;
function updateCurrentMonthButton(){
  if(!currentMonthBtn) return;
  currentMonthBtn.hidden = activePage==='summary' || selectedMonth===currentMonth;
}
currentMonthBtn.onclick=()=>{
  selectedMonth=currentMonth;
  globalMonth.value=currentMonth;
  formDirty=false;
  render();
};
function shiftSelectedMonth(delta){
  const [y,m]=String(selectedMonth||currentMonth).split('-').map(Number);
  const d=new Date(y,m-1+delta,1);
  selectedMonth=`${d.getFullYear()}-${pad(d.getMonth()+1)}`;
  globalMonth.value=selectedMonth;formDirty=false;render();
}
prevMonthBtn.onclick=()=>shiftSelectedMonth(-1);
nextMonthBtn.onclick=()=>shiftSelectedMonth(1);


function normalizeStateModel(input){
  const s={...structuredClone(defaultState),...(input||{})};
  s.settings={...structuredClone(defaultState.settings),...(s.settings||{})};
  s.settings.variableCategories=['고정','생활비','식비','이벤트'];
  s.settings.husbandCards=Array.isArray(s.settings.husbandCards)&&s.settings.husbandCards.length?s.settings.husbandCards:[...defaultState.settings.husbandCards];
  s.settings.wifeCards=Array.isArray(s.settings.wifeCards)&&s.settings.wifeCards.length?s.settings.wifeCards:[...defaultState.settings.wifeCards];
  s.settings.incomeCategories=Array.isArray(s.settings.incomeCategories)&&s.settings.incomeCategories.length?s.settings.incomeCategories:[...defaultState.settings.incomeCategories];
  s.settings.fixedCategories=Array.isArray(s.settings.fixedCategories)&&s.settings.fixedCategories.length?s.settings.fixedCategories:[...defaultState.settings.fixedCategories];
  s.settings.entryTabBehavior=['remember','first'].includes(s.settings.entryTabBehavior)?s.settings.entryTabBehavior:'remember';
  s.incomes=normalizeGroupedMonths(s.incomes||{});
  s.fixedExpenses=normalizeGroupedMonths(s.fixedExpenses||{});
  s.cardRecords=(s.cardRecords||[]).map(x=>{
    const o={...x};
    o.month=normalizeMonthKey(o.month);
    if(!o.owner){
      if(o.card==='남편카드') o.owner='남편';
      else if(o.card==='아내카드') o.owner='아내';
    }
    return o;
  });
  s.variableExpenses=(s.variableExpenses||[]).map(x=>{
    const o={...x};
    if(o.category==='아이관련생활비'){o.category='생활비';o.detailCategory='자녀';}
    else if(o.category==='생활비'&&!o.detailCategory){o.detailCategory='가정';}
    else if(o.category==='아이관련식비'){o.category='식비';o.detailCategory='자녀';}
    else if(o.category==='식비'&&!o.detailCategory){o.detailCategory='가정';}
    if(o.category==='고정'||o.category==='이벤트') o.detailCategory='';
    return o;
  });
  return s;
}
function loadState(){
  try { return normalizeStateModel({...structuredClone(defaultState), ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')}); }
  catch { return normalizeStateModel(structuredClone(defaultState)); }
}
function saveLocalOnly(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

function parseTime(v){const t=Date.parse(String(v||''));return Number.isFinite(t)?t:0;}
function mergeRecordArrays(localArr,remoteArr,entity=''){
  const map=new Map();
  [...(remoteArr||[]),...(localArr||[])].forEach(rec=>{
    if(!rec||!rec.id)return;
    if(entity && isLocallyDeleted(entity,rec.id))return;
    const k=String(rec.id),old=map.get(k);
    if(!old){map.set(k,{...rec});return;}
    const ot=Math.max(parseTime(old.updatedAt),parseTime(old.createdAt));
    const nt=Math.max(parseTime(rec.updatedAt),parseTime(rec.createdAt));
    if(nt>=ot)map.set(k,{...old,...rec});
  });
  return [...map.values()];
}
function mergeStateNoLoss(localState,remoteState){
  const remote=normalizeStateModel({...structuredClone(defaultState),...(remoteState||{})});
  const local=normalizeStateModel({...structuredClone(defaultState),...(localState||{})});
  remote.variableExpenses=mergeRecordArrays(local.variableExpenses,remote.variableExpenses,'variableExpenses');
  remote.cardRecords=mergeRecordArrays(local.cardRecords,remote.cardRecords,'cardRecords');
  const mg=(a,b,entity)=>{
    a=normalizeGroupedMonths(a||{}); b=normalizeGroupedMonths(b||{});
    const out={},ms=new Set([...Object.keys(a),...Object.keys(b)]);
    ms.forEach(m=>out[m]=mergeRecordArrays(a[m]||[],b[m]||[],entity).map(r=>({...r,month:m})));
    return out;
  };
  remote.incomes=mg(local.incomes,remote.incomes,'incomes');
  remote.fixedExpenses=mg(local.fixedExpenses,remote.fixedExpenses,'fixedExpenses');
  remote.monthlyLimits={...(remote.monthlyLimits||{}),...(local.monthlyLimits||{})};
  remote.settings={...local.settings,...remote.settings};
  return normalizeStateModel(remote);
}
function saveState(){ saveLocalOnly(); remoteSave(); }
function won(n){ return `${Math.round(Number(n)||0).toLocaleString('ko-KR')}원`; }
function compactWon(n){
  n=Number(n)||0;
  const a=Math.abs(n);
  if(a>=100000000){
    const v=n/100000000;
    return `${v.toFixed(a>=1000000000?1:2).replace(/\.?0+$/,'')}억`;
  }
  if(a>=10000){
    const v=n/10000;
    return `${v.toFixed(a>=100000?0:1).replace(/\.?0+$/,'')}만`;
  }
  return Math.round(n).toLocaleString('ko-KR');
}
function parseAmount(v){
  const s=String(v??'').replace(/[,\s]/g,'');
  if(s==='')return NaN;
  const n=Number(s);
  return Number.isFinite(n)?n:NaN;
}
function commaNumber(v){
  const s=String(v??'').replace(/[^\d]/g,'');
  if(!s)return '';
  return Number(s).toLocaleString('ko-KR');
}
function bindMoneyInputs(){
  app.querySelectorAll('input[name="amount"],input[name="reimbursedAmount"],input[data-k="amount"]').forEach(el=>{
    if(el.dataset.moneyBound==='1')return;
    el.dataset.moneyBound='1';
    el.type='text';el.inputMode='numeric';el.autocomplete='off';
    if(el.value!=='')el.value=commaNumber(el.value);
    el.addEventListener('input',()=>{
      const caretFromEnd=el.value.length-(el.selectionStart||el.value.length);
      el.value=commaNumber(el.value);
      const p=Math.max(0,el.value.length-caretFromEnd);
      try{el.setSelectionRange(p,p)}catch{}
    });
    el.addEventListener('blur',()=>{if(el.value!=='')el.value=commaNumber(el.value);});
  });
}
function monthOf(date){ return String(date||'').slice(0,7); }
function normalizeMonthKey(v){
  const s=String(v||'').trim();
  const m=s.match(/^(\d{4})-(\d{2})/);
  return m?`${m[1]}-${m[2]}`:s.slice(0,7);
}
function normalizeGroupedMonths(grouped){
  const out={};
  Object.entries(grouped||{}).forEach(([key,rows])=>{
    const mk=normalizeMonthKey(key);
    if(!mk)return;
    out[mk]=[...(out[mk]||[]),...(rows||[])].map(r=>({...r,month:mk}));
  });
  return out;
}
function id(){ return `${Date.now()}_${Math.random().toString(36).slice(2,8)}`; }
function esc(s=''){ return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function toast(msg){ const el=document.getElementById('toast'); el.textContent=msg; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),1800); }

function applyBrand(){
  const icon=String(state.settings.brandIcon||'₩').slice(0,3);
  const title=String(state.settings.brandTitle||'우리집 가계부');
  const sub=String(state.settings.brandSubtitle||'Couple Budget');
  document.querySelectorAll('.brand-mark').forEach(el=>{if(!el.classList.contains('pin-brand')||el.classList.contains('pin-brand'))el.textContent=icon;});
  const brand=document.querySelector('.brand');
  if(brand){
    const strong=brand.querySelector('strong'),span=brand.querySelector('span');
    if(strong)strong.textContent=title;if(span)span.textContent=sub;
  }
  const pinTitle=document.querySelector('.pin-card h2'); if(pinTitle)pinTitle.textContent=title;
  document.title=title;
}
function renderNav(){
  nav.innerHTML = pages.map(([key,icon,label])=>`<button class="nav-item ${activePage===key?'active':''}" data-page="${key}"><span class="nav-icon">${icon}</span>${label}</button>`).join('');
  nav.querySelectorAll('button').forEach(b=>b.onclick=()=>{
    formDirty=false;
    if(activePage==='add') clearExpenseDraft();
    const nextPage=b.dataset.page;
    if(nextPage==='details') detailsSortMode='latest';
    activePage=nextPage;
    closeMenu();
    window.scrollTo({top:0,left:0,behavior:'auto'});
    document.documentElement.scrollTop=0;
    document.body.scrollTop=0;
    render();
  });
}
function bindGlobalFormDirtyGuard(){
  bindMoneyInputs();
  app.querySelectorAll('form input,form select,form textarea').forEach(el=>{
    el.addEventListener('focus',()=>{formDirty=true;});
    el.addEventListener('input',()=>{formDirty=true;});
    el.addEventListener('change',()=>{formDirty=true;});
  });
}
function render(){
  applyBrand();
  renderNav();
  const meta = pages.find(p=>p[0]===activePage);
  pageTitle.textContent = meta[2]; pageSubtitle.textContent = meta[3];
  globalMonth.style.display = activePage==='summary' ? 'none' : '';
  updateCurrentMonthButton();
  if(activePage==='add') renderAdd();
  if(activePage==='details') renderDetails();
  if(activePage==='summary') renderSummary();
  if(activePage==='income') renderIncome();
  if(activePage==='fixed') renderFixed();
  if(activePage==='cards') renderCards();
  if(activePage==='settings') renderSettings();
  bindGlobalFormDirtyGuard();
  bindCategoryTrendTooltips();
  bindAnnualMainTooltips();
}

globalMonth.onchange=()=>{ selectedMonth=globalMonth.value || currentMonth; formDirty=false; render(); updateCurrentMonthButton(); };

document.getElementById('menuBtn').onclick=()=>{
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('backdrop').classList.add('show');
  document.body.classList.add('menu-open');
};
document.getElementById('backdrop').onclick=closeMenu;
initGlobalAdd();
function closeMenu(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('backdrop').classList.remove('show');
  document.body.classList.remove('menu-open');
}
function initGlobalAdd(){
  const btn=document.getElementById('globalAddBtn');
  const menu=document.getElementById('globalAddMenu');
  if(!btn||!menu)return;
  const close=()=>{menu.hidden=true;btn.classList.remove('open');};
  btn.onclick=e=>{
    e.stopPropagation();
    menu.hidden=!menu.hidden;
    btn.classList.toggle('open',!menu.hidden);
  };
  menu.querySelectorAll('button[data-page]').forEach(item=>item.onclick=()=>{
    activePage=item.dataset.page;
    formDirty=false;
    clearExpenseDraft();
    close();
    closeMenu();
    window.scrollTo({top:0,left:0,behavior:'auto'});
    document.documentElement.scrollTop=0;document.body.scrollTop=0;
    render();
    setTimeout(()=>{
      const target=document.querySelector('#expenseForm,#fixedForm,#incomeForm,#cardForm');
      if(target){
        target.closest('.card')?.classList.add('quick-add-target');
        const input=target.querySelector('input:not([type="hidden"]):not([type="checkbox"]),select');
        if(input)input.focus({preventScroll:true});
        setTimeout(()=>target.closest('.card')?.classList.remove('quick-add-target'),900);
      }
    },0);
  });
  document.addEventListener('click',e=>{if(!e.target.closest('#globalAddWrap'))close();});
}

function previousMonth(month){ const [y,m]=month.split('-').map(Number); const d=new Date(y,m-2,1); return `${d.getFullYear()}-${pad(d.getMonth()+1)}`; }
function dateInMonthLike(date, month){ const day=Math.max(1,Number(String(date||'').slice(8,10))||1); const [y,m]=month.split('-').map(Number); const last=new Date(y,m,0).getDate(); return `${month}-${pad(Math.min(day,last))}`; }
function categoryDisplayName(cat){ return cat==='고정'?'카드고정지출':cat; }
function expenseDisplayName(x){
  if(x.category==='고정') return '카드고정지출';
  if(x.category==='생활비') return `생활비(${x.detailCategory||'가정'})`;
  if(x.category==='식비') return `식비(${x.detailCategory||'가정'})`;
  if(x.category==='이벤트'&&x.eventCategory) return `이벤트(${x.eventCategory})`;
  return x.category||'';
}
function addMonthsClampedDate(date,offset){
  const s=String(date||'');
  const [y,m,d]=s.split('-').map(Number);
  if(!y||!m||!d)return s;
  const target=new Date(y,m-1+Number(offset||0),1);
  const last=new Date(target.getFullYear(),target.getMonth()+1,0).getDate();
  return `${target.getFullYear()}-${pad(target.getMonth()+1)}-${pad(Math.min(d,last))}`;
}
function splitIntegerAmount(total,count){
  total=Math.max(0,Math.round(Number(total)||0));
  count=Math.max(1,Math.round(Number(count)||1));
  const base=Math.floor(total/count);
  return Array.from({length:count},(_,i)=>i===count-1?total-base*(count-1):base);
}
function installmentLabel(x){
  const count=Number(x&&x.installmentCount)||1;
  const index=Number(x&&x.installmentIndex)||1;
  return count>1?`할부 ${index}/${count}`:'';
}

function expenseCreatedMs(x){
  const c=Date.parse(String(x&&x.createdAt||''));
  if(Number.isFinite(c)) return c;
  const idMs=Number(String(x&&x.id||'').split('_')[0]);
  return Number.isFinite(idMs)?idMs:0;
}
function sortExpensesNewestRegistered(a,b){
  const createdDiff=expenseCreatedMs(b)-expenseCreatedMs(a);
  if(createdDiff) return createdDiff;
  const dateDiff=String(b.date||'').localeCompare(String(a.date||''));
  if(dateDiff) return dateDiff;
  return String(b.id||'').localeCompare(String(a.id||''));
}
function expenseCategoryOrder(x){
  const order={고정:0,생활비:1,식비:2,이벤트:3};
  return Object.prototype.hasOwnProperty.call(order,x.category)?order[x.category]:9;
}
function expenseSubcategoryRank(x){
  if(x.category==='생활비'){
    const order=['가정','남편개인','자녀']; const i=order.indexOf(x.detailCategory||'가정'); return i<0?99:i;
  }
  if(x.category==='식비'){
    const order=['가정','자녀']; const i=order.indexOf(x.detailCategory||'가정'); return i<0?99:i;
  }
  if(x.category==='이벤트'){
    const order=state.settings.eventCategories||[]; const i=order.indexOf(x.eventCategory||''); return i<0?99:i;
  }
  return 0;
}
function expenseSubcategoryName(x){
  if(x.category==='생활비'||x.category==='식비')return String(x.detailCategory||'가정');
  if(x.category==='이벤트')return String(x.eventCategory||'');
  return '';
}
function sortExpensesByCategory(a,b){
  const c=expenseCategoryOrder(a)-expenseCategoryOrder(b);
  if(c) return c;
  const sr=expenseSubcategoryRank(a)-expenseSubcategoryRank(b);
  if(sr)return sr;
  const sn=expenseSubcategoryName(a).localeCompare(expenseSubcategoryName(b),'ko');
  if(sn)return sn;
  const dateDiff=String(a.date||'').localeCompare(String(b.date||''));
  if(dateDiff) return dateDiff;
  return String(a.id||'').localeCompare(String(b.id||''));
}
function sortExpensesByUsageDateLatest(a,b){
  const dateDiff=String(b.date||'').localeCompare(String(a.date||''));
  if(dateDiff) return dateDiff;
  const createdDiff=expenseCreatedMs(b)-expenseCreatedMs(a);
  if(createdDiff) return createdDiff;
  return String(b.id||'').localeCompare(String(a.id||''));
}
function categoryPillClass(x){
  if(x.category==='이벤트') return 'event';
  if(x.category==='생활비') return 'living';
  if(x.category==='식비') return 'food';
  if(x.category==='고정') return 'fixed';
  return '';
}
function reimbursementAmount(x){ return Math.max(0,Number((x&&x.reimbursedAmount)||0)); }
function effectiveExpenseAmount(x){ return Math.max(0,Number((x&&x.amount)||0)-reimbursementAmount(x)); }

async function protectedSetMonthlyLimit(month,amount,loginPin){
  const loginHash=await sha256(loginPin);
  if(!PIN_HASH || loginHash!==PIN_HASH) throw new Error('가계부 접속 PIN이 올바르지 않습니다.');
  setSyncStatus('가용금액 저장 중…');
  const res=await jsonpRequest({
    action:'setProtectedLimitWithLoginPin',
    month:String(month),
    amount:String(Number(amount)||0),
    loginPinHash:loginHash
  });
  if(!res || !res.ok) throw new Error((res&&res.error)||'가용금액 저장에 실패했습니다.');
  state.monthlyLimits[month]=Number(amount)||0;
  saveLocalOnly();
  setSyncStatus('가용금액 Google Sheets 저장됨');
  return true;
}


function monthStats(month){
  const income = (state.incomes[month]||[]).reduce((a,b)=>a+Number(b.amount||0),0);
  const fixed = (state.fixedExpenses[month]||[]).reduce((a,b)=>a+Number(b.amount||0),0);
  const monthExpenses = state.variableExpenses.filter(x=>monthOf(x.date)===month);
  const totalVariable = monthExpenses.reduce((a,b)=>a+effectiveExpenseAmount(b),0);
  // 가용금액은 생활성 지출만 차감: 카드 고정지출(고정)과 이벤트는 제외
  const budgetVariable = monthExpenses
    .filter(x=>x.category!=='고정' && x.category!=='이벤트')
    .reduce((a,b)=>a+effectiveExpenseAmount(b),0);
  const limit = Number(state.monthlyLimits[month] || Math.max(income-fixed,0));
  return {income,fixed,variable:totalVariable,budgetVariable,limit,remaining:limit-budgetVariable};
}

function expenseCategoryOptions(){
  const events=(state.settings.eventCategories||[]).map(e=>({value:`이벤트::${e}`,label:`이벤트(${e})`}));
  return [
    {value:'고정',label:'카드고정지출'},
    {value:'생활비::가정',label:'생활비(가정)'},
    {value:'생활비::남편개인',label:'생활비(남편개인)'},
    {value:'생활비::자녀',label:'생활비(자녀)'},
    {value:'식비::가정',label:'식비(가정)'},
    {value:'식비::자녀',label:'식비(자녀)'},
    ...events
  ];
}
function parseExpenseCategory(value){
  const v=String(value||'');
  if(v.startsWith('이벤트::')) return {category:'이벤트',detailCategory:'',eventCategory:v.slice(5)};
  if(v.startsWith('생활비::')) return {category:'생활비',detailCategory:v.slice(5),eventCategory:''};
  if(v.startsWith('식비::')) return {category:'식비',detailCategory:v.slice(4),eventCategory:''};
  return {category:v,detailCategory:'',eventCategory:''};
}
function balanceClass(s){
  if(s.remaining<0) return 'balance-danger';
  if(s.limit>0 && s.remaining/s.limit>=0.30) return 'balance-safe';
  return 'balance-warn';
}

function renderAdd(){
  const s=monthStats(selectedMonth);
  const pct=s.limit>0?Math.min(100,(s.budgetVariable/s.limit)*100):0;
  const options=expenseCategoryOptions();
  const defaultValue=options.length?options[0].value:'';
  const draft=expenseDraft||{};
  const draftChoice=draft.categoryChoice||defaultValue;
  const draftAmount=draft.amount||'';
  const draftDate=draft.date||(selectedMonth===currentMonth?todayStr:selectedMonth+'-01');
  const methodTabs=['남편카드','아내카드','현금'];
  const draftMethod=draft.method||preferredEntryTab('expenseMethod',methodTabs);
  const draftMemo=draft.memo||'';
  app.innerHTML=`
    <div class="budget-summary-grid">
      <button class="metric budget-summary-item budget-limit-card" id="editLimitCard" type="button" aria-label="이번 달 사용가능 금액 수정">
        <div class="metric-label">이번 달 사용가능 금액</div>
        <div class="metric-value">${won(s.limit)}</div>
        <div class="metric-foot">금액을 눌러 수정</div>
      </button>
      <div class="metric budget-summary-item">
        <div class="metric-label">생활예산 사용액</div>
        <div class="metric-value">${won(s.budgetVariable)}</div>
        <div class="metric-foot">카드고정지출·이벤트 제외</div>
      </div>
      <div class="metric budget-summary-item ${balanceClass(s)}">
        <div class="metric-label">남은 금액</div>
        <div class="metric-value">${won(s.remaining)}</div>
        <div class="metric-foot">가용금액 대비 잔액</div>
      </div>
      <div class="budget-summary-progress">
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="progress-note"><span>${pct.toFixed(0)}% 사용</span><span>${s.limit?won(s.remaining):'가용금액 미설정'}</span></div>
      </div>
    </div>
    <div class="grid cols-2 section-gap">
      <div class="card">
        <div class="card-head"><div><h2>변동지출 등록</h2><p>생활비·식비·이벤트는 세부 항목을 바로 선택할 수 있습니다.</p></div><button class="btn small copy-fixed-btn" id="copyCardFixedBtn" type="button">전월 카드고정지출 복사</button></div>
        <div class="quick-cat-groups" id="quickCats">
          <div class="quick-cat-group fixed-group"><span class="quick-cat-label">고정</span><div class="quick-cats">${options.filter(o=>o.value==='고정').map(o=>`<button type="button" class="chip chip-fixed ${o.value===draftChoice?'active':''}" data-value="${esc(o.value)}">${esc(o.label)}</button>`).join('')}</div></div>
          <div class="quick-cat-group living-group"><span class="quick-cat-label">생활비</span><div class="quick-cats">${options.filter(o=>o.value.startsWith('생활비::')).map(o=>`<button type="button" class="chip chip-living ${o.value===draftChoice?'active':''}" data-value="${esc(o.value)}">${esc(o.value.split('::')[1])}</button>`).join('')}</div></div>
          <div class="quick-cat-group food-group"><span class="quick-cat-label">식비</span><div class="quick-cats">${options.filter(o=>o.value.startsWith('식비::')).map(o=>`<button type="button" class="chip chip-food ${o.value===draftChoice?'active':''}" data-value="${esc(o.value)}">${esc(o.value.split('::')[1])}</button>`).join('')}</div></div>
          <div class="quick-cat-group event-group"><span class="quick-cat-label">이벤트</span><div class="quick-cats">${options.filter(o=>o.value.startsWith('이벤트::')).map(o=>`<button type="button" class="chip chip-event ${o.value===draftChoice?'active':''}" data-value="${esc(o.value)}">${esc(o.value.split('::')[1])}</button>`).join('')}</div></div>
        </div>
        <div class="divider"></div>
        <form id="expenseForm" class="compact-expense-form" novalidate>
          <div class="form-grid">
            <input type="hidden" name="categoryChoice" id="expenseCat" value="${esc(draftChoice)}">
            <div class="field"><label>사용금액</label><input name="amount" type="number" min="1" inputmode="numeric" placeholder="예: 35000" value="${esc(draftAmount)}"></div>
            <div class="field"><label>사용날짜</label><input name="date" type="date" value="${esc(draftDate)}"></div>
            <div class="field full"><label>지출방식</label><input type="hidden" name="method" id="expenseMethod" value="${esc(draftMethod||'남편카드')}"><div class="segmented expense-method-tabs" id="expenseMethodTabs">${methodTabs.map(m=>`<button type="button" class="${m===draftMethod?'active':''}" data-method="${m}">${m}</button>`).join('')}</div></div>
            <div class="field full"><label>사용내역</label><input name="memo" placeholder="예: 마트 장보기, 아기 기저귀, 외식" value="${esc(draftMemo)}"></div>
          <div class="field full settlement-field">
            <label class="settlement-toggle"><input type="checkbox" id="settlementToggle" ${Number(draft.reimbursedAmount||0)>0?'checked':''}><span>대납·정산 있음</span></label>
            <div id="settlementAmountWrap" class="${Number(draft.reimbursedAmount||0)>0?'':'hidden'}">
              <input name="reimbursedAmount" type="number" min="0" inputmode="numeric" placeholder="돌려받았거나 받을 금액" value="${esc(draft.reimbursedAmount||'')}">
              <div class="helper-text">가계부 지출에는 결제액에서 회수금액을 뺀 금액만 반영됩니다.</div>
            </div>
          </div>
          <div class="field full installment-field">
            <label class="settlement-toggle"><input type="checkbox" id="installmentToggle" ${Number(draft.installmentCount||1)>1?'checked':''}><span>카드 할부</span></label>
            <div id="installmentCountWrap" class="${Number(draft.installmentCount||1)>1?'':'hidden'}">
              <label class="inline-installment-label">할부 개월 수
                <select name="installmentCount">${Array.from({length:23},(_,i)=>i+2).map(n=>`<option value="${n}" ${Number(draft.installmentCount||1)===n?'selected':''}>${n}개월</option>`).join('')}</select>
              </label>
              <div class="helper-text">총 결제금액을 월별로 나누어 각 달의 변동지출과 생활예산에 반영합니다.</div>
            </div>
          </div>
          </div>
          <div id="expenseFormMsg" class="helper-text"></div>
          <div class="button-row"><button type="submit" class="btn primary">지출 등록</button></div>
        </form>
      </div>
      <div class="grid">
        <div class="card"><div class="card-head"><div><h2>최근 등록</h2><p>최근 5건</p></div><button class="btn small" id="goDetails">전체 보기</button></div>${recentExpensesHtml()}</div>
      </div>
    </div>`;

  const form=document.getElementById('expenseForm');
  const cat=document.getElementById('expenseCat');
  const msg=document.getElementById('expenseFormMsg');
  const rememberDraft=()=>snapshotExpenseDraft(form);
  form.querySelectorAll('input,select').forEach(el=>{
    el.addEventListener('focus',()=>{ formDirty=true; });
    el.addEventListener('input',rememberDraft);
    el.addEventListener('change',rememberDraft);
  });
  cat.onchange=()=>{
    rememberDraft();
    document.querySelectorAll('#quickCats .chip').forEach(x=>x.classList.toggle('active',x.dataset.value===cat.value));
  };
  document.querySelectorAll('#quickCats .chip').forEach(b=>b.onclick=()=>{
    snapshotExpenseDraft(form);
    cat.value=b.dataset.value;
    expenseDraft={...(expenseDraft||{}),categoryChoice:cat.value};
    formDirty=true;
    document.querySelectorAll('#quickCats .chip').forEach(x=>x.classList.toggle('active',x===b));
  });
  const methodInput=document.getElementById('expenseMethod');
  document.querySelectorAll('#expenseMethodTabs button').forEach(b=>b.onclick=()=>{
    methodInput.value=b.dataset.method;
    document.querySelectorAll('#expenseMethodTabs button').forEach(x=>x.classList.toggle('active',x===b));
    snapshotExpenseDraft(form);
    expenseDraft={...(expenseDraft||{}),method:methodInput.value};
    rememberEntryTab('expenseMethod',methodInput.value);
    formDirty=true;
  });
  const settlementToggle=document.getElementById('settlementToggle');
  const settlementWrap=document.getElementById('settlementAmountWrap');
  settlementToggle.onchange=()=>{
    settlementWrap.classList.toggle('hidden',!settlementToggle.checked);
    if(!settlementToggle.checked && form.elements.reimbursedAmount) form.elements.reimbursedAmount.value='';
    snapshotExpenseDraft(form);
  };
  const installmentToggle=document.getElementById('installmentToggle');
  const installmentWrap=document.getElementById('installmentCountWrap');
  installmentToggle.onchange=()=>{
    installmentWrap.classList.toggle('hidden',!installmentToggle.checked);
    if(!installmentToggle.checked && form.elements.installmentCount)form.elements.installmentCount.value='2';
    snapshotExpenseDraft(form);
  };


  form.onsubmit=e=>{
    e.preventDefault();
    const f=new FormData(form);
    const amount=parseAmount(f.get('amount'));
    const reimbursedAmount=(String(f.get('reimbursedAmount')||'').trim()===''?0:parseAmount(f.get('reimbursedAmount')));
    const date=String(f.get('date')||'').trim();
    const method=String(f.get('method')||'').trim();
    const choice=String(f.get('categoryChoice')||defaultValue).trim();
    const parsed=parseExpenseCategory(choice);
    msg.textContent=''; msg.className='helper-text';
    if(!parsed.category){ msg.textContent='대분류를 선택해 주세요.'; msg.className='helper-text error'; cat.focus(); return; }
    if(!Number.isFinite(amount) || amount<=0){ msg.textContent='사용금액을 1원 이상 입력해 주세요.'; msg.className='helper-text error'; form.elements.amount.focus(); return; }
    if(!date){ msg.textContent='사용날짜를 선택해 주세요.'; msg.className='helper-text error'; form.elements.date.focus(); return; }
    if(!method){ msg.textContent='지출방식을 선택해 주세요.'; msg.className='helper-text error'; form.elements.method.focus(); return; }
    const installmentCount=installmentToggle.checked?Math.max(2,Number(f.get('installmentCount'))||2):1;
    const createdNow=new Date().toISOString();
    const memo=String(f.get('memo')||'').trim();
    const groupId=installmentCount>1?id():'';
    const amounts=splitIntegerAmount(amount,installmentCount);
    const reimbursements=splitIntegerAmount(reimbursedAmount,installmentCount);
    const records=amounts.map((part,index)=>({
      id:id(),category:parsed.category,detailCategory:parsed.detailCategory,eventCategory:parsed.eventCategory,
      amount:part,reimbursedAmount:reimbursements[index]||0,date:addMonthsClampedDate(date,index),memo,method,
      installmentGroupId:groupId,installmentIndex:index+1,installmentCount,
      originalAmount:installmentCount>1?amount:0,purchaseDate:installmentCount>1?date:'',
      createdAt:createdNow,updatedAt:createdNow
    }));
    state.variableExpenses.push(...records);
    formDirty=false;
    clearExpenseDraft();
    saveLocalOnly();
    queuePendingUpserts('variableExpenses',records);
    flushPendingUpserts().catch(console.error);
    toast(installmentCount>1?`${installmentCount}개월 할부로 등록했습니다.`:'변동지출을 등록했습니다.');
    renderAdd();
  };
  document.getElementById('editLimitCard').onclick=async()=>{
    const pin=prompt('가용금액을 수정하려면 현재 가계부 접속 PIN을 입력하세요.');
    if(pin===null) return;
    const loginHash=await sha256(pin);
    if(!PIN_HASH || loginHash!==PIN_HASH){ alert('가계부 접속 PIN이 올바르지 않습니다.'); return; }
    const v=prompt(`${selectedMonth} 생활예산 사용가능 금액을 입력하세요.`, s.limit||'');
    if(v!==null && v!=='' && Number(v)>=0){
      try{ await protectedSetMonthlyLimit(selectedMonth,Number(v),pin); formDirty=false; renderAdd(); toast('가용금액을 저장했습니다.'); }
      catch(err){ alert(err.message||'저장에 실패했습니다.'); }
    }
  };
  const copyBtn=document.getElementById('copyCardFixedBtn');
  if(copyBtn) copyBtn.onclick=()=>{
    const prev=previousMonth(selectedMonth); const src=state.variableExpenses.filter(x=>monthOf(x.date)===prev&&x.category==='고정');
    if(!src.length){alert(`${prev}에 카드고정지출이 없습니다.`);return;}
    if(!confirm(`${prev} 카드고정지출 ${src.length}건을 ${selectedMonth}로 복사할까요?`)) return;
    const existing=state.variableExpenses.filter(x=>monthOf(x.date)===selectedMonth&&x.category==='고정'); let added=0;
    src.forEach(x=>{ if(existing.some(e=>e.memo===x.memo&&Number(e.amount)===Number(x.amount)&&e.method===x.method)) return; state.variableExpenses.push({...x,id:id(),date:dateInMonthLike(x.date,selectedMonth),createdAt:'',updatedAt:''}); added++; });
    if(added){
      const addedRows=state.variableExpenses.filter(x=>monthOf(x.date)===selectedMonth&&x.category==='고정'&&!existing.some(e=>e.id===x.id));
      saveLocalOnly();queuePendingUpserts('variableExpenses',addedRows);flushPendingUpserts().catch(console.error);renderAdd();toast(`${added}건을 복사했습니다.`);
    } else alert('이미 같은 카드고정지출이 등록되어 있습니다.');
  };
  document.getElementById('goDetails').onclick=()=>{
    formDirty=false;
    clearExpenseDraft();
    detailsSortMode='registered';
    activePage='details';
    render();
    requestAnimationFrame(()=>{
      const target=document.getElementById('expenseDetailSection');
      if(target){
        const header=document.querySelector('.topbar');
        const offset=(header&&getComputedStyle(header).position==='fixed'?header.getBoundingClientRect().height:0)+10;
        const y=target.getBoundingClientRect().top+window.scrollY-offset;
        window.scrollTo({top:Math.max(0,y),left:0,behavior:'auto'});
      }
    });
  };
}

function recentExpensesHtml(){
  const arr=state.variableExpenses.filter(x=>monthOf(x.date)===selectedMonth).sort(sortExpensesNewestRegistered).slice(0,5);
  if(!arr.length)return `<div class="empty">아직 등록된 지출이 없습니다.</div>`;
  return `<div class="recent-list">${arr.map(x=>`<div class="recent-row"><span class="recent-memo">${esc(x.memo||expenseDisplayName(x))}</span><span class="recent-date">${esc(x.date)}</span><span class="recent-method">${esc(x.method)}</span><span class="recent-amount">${won(x.amount)}</span></div>`).join('')}</div>`;
}

function yearComparisonMonths(year){
  const months=[...new Set(state.variableExpenses
    .filter(x=>String(x.date||'').startsWith(year+'-'))
    .map(x=>monthOf(x.date))
    .filter(Boolean))].sort();
  return months;
}
function yearMonthlyAverage(year, category, detailCategory='', eventCategory=''){
  const months=yearComparisonMonths(year);
  if(!months.length) return 0;
  const total=state.variableExpenses
    .filter(x=>String(x.date||'').startsWith(year+'-'))
    .filter(x=>x.category===category)
    .filter(x=>!detailCategory || x.detailCategory===detailCategory)
    .filter(x=>category!=='이벤트' || !eventCategory || x.eventCategory===eventCategory)
    .reduce((a,b)=>a+effectiveExpenseAmount(b),0);
  return total/months.length;
}
function averageCompareMarkup(current, average){
  current=Number(current)||0; average=Number(average)||0;
  if(average<=0) return `<span class="avg-neutral">기록월 없음</span>`;
  const pct=((current-average)/average)*100;
  if(Math.abs(pct)<1) return `<span class="avg-neutral">기록월 ≈</span>`;
  if(pct>0) return `<span class="avg-high">기록월 +${Math.abs(pct).toFixed(0)}%</span>`;
  return `<span class="avg-low">기록월 -${Math.abs(pct).toFixed(0)}%</span>`;
}
function renderDetails(){
  let rows=state.variableExpenses.filter(x=>monthOf(x.date)===selectedMonth);
  rows.sort(detailsSortMode==='category'?sortExpensesByCategory:(detailsSortMode==='registered'?sortExpensesNewestRegistered:sortExpensesByUsageDateLatest));
  const total=rows.reduce((a,b)=>a+effectiveExpenseAmount(b),0); const year=selectedMonth.slice(0,4);
  const groupCard=(title,category,details)=>{
    const amount=rows.filter(x=>x.category===category).reduce((a,b)=>a+effectiveExpenseAmount(b),0);
    const avg=yearMonthlyAverage(year,category);
    const lines=details.map(d=>{
      const val=rows.filter(x=>x.category===category && (category==='이벤트'?x.eventCategory===d:x.detailCategory===d)).reduce((a,b)=>a+effectiveExpenseAmount(b),0);
      const av=category==='이벤트'?yearMonthlyAverage(year,category,'',d):yearMonthlyAverage(year,category,d,'');
      return `<div class="event-summary-line"><span>${esc(d)}</span><strong>${won(val)}</strong><span class="event-avg">${averageCompareMarkup(val,av)}</span></div>`;
    }).join('');
    return `<div class="category-summary-card ${details.length?'event-summary-card':''}"><div class="category-summary-head"><span>${esc(title)}</span><strong>${won(amount)}</strong></div><div class="category-average">${averageCompareMarkup(amount,avg)}</div>${details.length?`<div class="event-summary-list">${lines}</div>`:''}</div>`;
  };
  const cards=[
    groupCard('카드고정지출','고정',[]),
    groupCard('생활비','생활비',['가정','남편개인','자녀']),
    groupCard('식비','식비',['가정','자녀']),
    groupCard('이벤트','이벤트',state.settings.eventCategories||[])
  ].join('');
  app.innerHTML=`
    <div class="grid cols-3"><div class="card metric"><div class="metric-label">총 변동지출</div><div class="metric-value">${won(total)}</div></div><div class="card metric"><div class="metric-label">등록 건수</div><div class="metric-value">${rows.length}건</div></div><div class="card metric"><div class="metric-label">일 평균 지출</div><div class="metric-value">${won(rows.length?total/new Date(+selectedMonth.slice(0,4),+selectedMonth.slice(5,7),0).getDate():0)}</div></div></div>
    <div class="card section-gap category-summary-section"><div class="card-head"><div><h2>대분류별 지출</h2><p>${year}년 실제 기록이 있는 월 기준 월평균과 비교합니다.</p></div></div><div class="category-summary-grid category-summary-grid-variable variable-summary-4x1">${cards}</div></div>
    <div class="section-gap">${categoryTrendChart('variableExpenses',['고정','생활비','식비','이벤트'],year,selectedMonth,'변동지출 대분류 월별 추이')}</div>
    <div class="card section-gap" id="expenseDetailSection"><div class="card-head details-head"><div><h2>${selectedMonth} 세부 내역</h2><p>사용날짜·분류·실제 등록시간 기준으로 정렬할 수 있습니다.</p></div><div class="segmented details-sort"><button type="button" class="${detailsSortMode==='latest'?'active':''}" data-sort="latest">사용일 최신</button><button type="button" class="${detailsSortMode==='category'?'active':''}" data-sort="category">분류별</button><button type="button" class="${detailsSortMode==='registered'?'active':''}" data-sort="registered">등록 최신</button></div></div><div class="table-wrap">${rows.length?`<table class="table"><thead><tr><th>날짜</th><th>분류</th><th>사용내역</th><th>지출방식</th><th class="amount">금액</th><th></th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.date)}</td><td><span class="pill ${categoryPillClass(x)}">${esc(expenseDisplayName(x))}</span></td><td>${esc(x.memo||'-')}${installmentLabel(x)?`<div class="installment-note">${esc(installmentLabel(x))}${x.purchaseDate?` · 결제 ${esc(x.purchaseDate)}`:''}</div>`:''}</td><td>${esc(x.method)}</td><td class="amount"><strong>${won(effectiveExpenseAmount(x))}</strong>${reimbursementAmount(x)>0?`<div class="muted tiny-note">결제 ${won(x.amount)} · 회수 ${won(reimbursementAmount(x))}</div>`:''}</td><td><div class="row-actions"><button class="btn small edit-exp" data-id="${x.id}">수정</button><button class="btn small danger delete-exp" data-id="${x.id}">삭제</button></div></td></tr>`).join('')}</tbody></table>`:`<div class="empty">${selectedMonth}에 등록된 내역이 없습니다.</div>`}</div></div>`;
  document.querySelectorAll('.details-sort button').forEach(b=>b.onclick=()=>{detailsSortMode=b.dataset.sort||'latest';renderDetails();});
  document.querySelectorAll('.delete-exp').forEach(b=>b.onclick=()=>{
    const rid=b.dataset.id;
    const target=state.variableExpenses.find(x=>x.id===rid);
    const groupId=target&&target.installmentGroupId;
    const targets=groupId?state.variableExpenses.filter(x=>x.installmentGroupId===groupId):[target].filter(Boolean);
    const message=groupId?`${Number(target.installmentCount)||targets.length}개월 할부 전체 내역을 삭제할까요?`:'이 지출 내역을 삭제할까요?';
    if(!confirm(message))return;
    const ids=new Set(targets.map(x=>String(x.id)));
    targets.forEach(x=>markLocalDeleted('variableExpenses',x.id));
    state.variableExpenses=state.variableExpenses.filter(x=>!ids.has(String(x.id)));
    saveLocalOnly();renderDetails();flushPendingDeletes().catch(console.error);
  });
  document.querySelectorAll('.edit-exp').forEach(b=>b.onclick=()=>renderExpenseEdit(b.dataset.id));
}

function renderExpenseEdit(expenseId){
  const x=state.variableExpenses.find(v=>v.id===expenseId);
  if(!x){ renderDetails(); return; }
  if(Number(x.installmentCount||1)>1){
    alert('할부 내역은 여러 달의 예산과 연결되어 있어 현재는 개별 수정하지 않습니다. 전체 할부를 삭제한 뒤 다시 등록해 주세요.');
    renderDetails();return;
  }
  const options=expenseCategoryOptions();
  const currentChoice=x.category==='이벤트'?`이벤트::${x.eventCategory||''}`:(x.category==='생활비'||x.category==='식비'?`${x.category}::${x.detailCategory||'가정'}`:x.category);
  app.innerHTML=`<div class="card expense-edit-card">
    <div class="card-head"><div><h2>변동지출 수정</h2><p>수정 내용은 예산과 통계에 즉시 다시 반영됩니다.</p></div></div>
    <form id="editExpenseForm" novalidate>
      <div class="form-grid">
        <div class="field"><label>대분류</label><select name="categoryChoice">${options.map(o=>`<option value="${esc(o.value)}" ${o.value===currentChoice?'selected':''}>${esc(o.label)}</option>`).join('')}</select></div>
        <div class="field"><label>사용금액</label><input name="amount" type="number" min="1" inputmode="numeric" value="${Number(x.amount)||0}"></div>
        <div class="field"><label>사용날짜</label><input name="date" type="date" value="${esc(x.date)}"></div>
        <div class="field"><label>지출방식</label><select name="method">${state.settings.methods.map(m=>`<option ${m===x.method?'selected':''}>${esc(m)}</option>`).join('')}</select></div>
        <div class="field full"><label>사용내역</label><input name="memo" value="${esc(x.memo||'')}"></div><div class="field full"><label>대납·정산 회수금액</label><input name="reimbursedAmount" type="number" min="0" inputmode="numeric" value="${reimbursementAmount(x)}"><div class="helper-text">없으면 0원</div></div>
      </div>
      <div id="editExpenseMsg" class="helper-text"></div>
      <div class="button-row"><button type="button" class="btn" id="cancelExpenseEdit">취소</button><button type="submit" class="btn primary">수정 저장</button></div>
    </form>
  </div>`;
  document.getElementById('cancelExpenseEdit').onclick=()=>renderDetails();
  document.getElementById('editExpenseForm').onsubmit=e=>{
    e.preventDefault();
    const f=new FormData(e.target);
    const amount=parseAmount(f.get('amount'));
    const reimbursedAmount=(String(f.get('reimbursedAmount')||'').trim()===''?0:parseAmount(f.get('reimbursedAmount')));
    const date=String(f.get('date')||'').trim();
    const method=String(f.get('method')||'').trim();
    const parsed=parseExpenseCategory(String(f.get('categoryChoice')||''));
    const msg=document.getElementById('editExpenseMsg');
    if(!parsed.category || !Number.isFinite(amount) || amount<=0 || !date || !method || !Number.isFinite(reimbursedAmount) || reimbursedAmount<0 || reimbursedAmount>amount){
      msg.textContent='대분류, 금액, 날짜, 지출방식을 확인해 주세요.';
      msg.className='helper-text error';
      return;
    }
    Object.assign(x,{category:parsed.category,detailCategory:parsed.detailCategory,eventCategory:parsed.eventCategory,amount,reimbursedAmount,date,method,memo:String(f.get('memo')||'').trim(),updatedAt:new Date().toISOString()});
    formDirty=false;
    saveLocalOnly();
    queuePendingUpserts('variableExpenses',[x]);
    flushPendingUpserts().catch(console.error);
    toast('지출 내역을 수정했습니다.');
    selectedMonth=monthOf(date)||selectedMonth;
    globalMonth.value=selectedMonth;
    renderDetails();
  };
}

function variableCategoryTotals(month){
  const rows=state.variableExpenses.filter(x=>monthOf(x.date)===month);
  const order=['고정','생활비','식비','이벤트'];
  const out={};
  order.forEach(c=>out[c]=rows.filter(x=>x.category===c).reduce((a,b)=>a+effectiveExpenseAmount(b),0));
  return out;
}
function groupedCategoryTotals(grouped,month){
  const out={};
  (grouped[month]||[]).forEach(x=>{const c=x.category||'미분류';out[c]=(out[c]||0)+Number(x.amount||0);});
  return out;
}
function summaryBarSvg(stats){
  const max=Math.max(1,...stats.map(s=>Math.max(s.income,s.fixed+s.variable)));
  const W=900,H=260,left=34,bottom=34,top=18,plotH=H-bottom-top,step=(W-left-12)/12,barW=Math.max(8,step*.24);
  let els=[];
  stats.forEach((s,i)=>{
    const x=left+i*step+step*.26;
    const ih=(s.income/max)*plotH,eh=((s.fixed+s.variable)/max)*plotH;
    els.push(`<g class="annual-main-hit" data-tooltip-label="${i+1}월 수입" data-tooltip-value="${won(s.income)}">
      <rect class="annual-main-hit-area" x="${(x-5).toFixed(1)}" y="${top}" width="${(barW+10).toFixed(1)}" height="${plotH}"/>
      <rect class="sum-bar income" x="${x.toFixed(1)}" y="${(top+plotH-ih).toFixed(1)}" width="${barW.toFixed(1)}" height="${ih.toFixed(1)}" rx="3"/>
    </g>`);
    els.push(`<g class="annual-main-hit" data-tooltip-label="${i+1}월 지출" data-tooltip-value="${won(s.fixed+s.variable)}">
      <rect class="annual-main-hit-area" x="${(x+barW-1).toFixed(1)}" y="${top}" width="${(barW+10).toFixed(1)}" height="${plotH}"/>
      <rect class="sum-bar expense" x="${(x+barW+4).toFixed(1)}" y="${(top+plotH-eh).toFixed(1)}" width="${barW.toFixed(1)}" height="${eh.toFixed(1)}" rx="3"/>
    </g>`);
    els.push(`<text x="${(x+barW).toFixed(1)}" y="${H-10}" text-anchor="middle">${i+1}</text>`);
  });
  return `<svg class="annual-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="월별 수입과 지출 비교"><line x1="${left}" y1="${top+plotH}" x2="${W-8}" y2="${top+plotH}" class="axis"/>${els.join('')}</svg>`;
}
function summaryNetSvg(stats){
  const vals=stats.map(s=>s.income-s.fixed-s.variable);
  const max=Math.max(1,...vals.map(Math.abs));
  const W=900,H=260,left=34,top=18,bottom=34,plotH=H-top-bottom,step=(W-left-12)/11;
  const zero=top+plotH/2;
  const pts=vals.map((v,i)=>`${(left+i*step).toFixed(1)},${(zero-(v/max)*(plotH*.42)).toFixed(1)}`).join(' ');
  return `<svg class="annual-net-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="월별 순현금흐름">
    <line x1="${left}" y1="${zero}" x2="${W-8}" y2="${zero}" class="axis zero"/>
    <polyline points="${pts}" fill="none" class="net-line"/>
    ${vals.map((v,i)=>{
      const x=left+i*step,y=zero-(v/max)*(plotH*.42);
      return `<g class="annual-main-hit" data-tooltip-label="${i+1}월 순현금흐름" data-tooltip-value="${won(v)}">
        <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="13" class="annual-main-hit-area"/>
        <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" class="${v>=0?'net-pos':'net-neg'}"/>
      </g><text x="${x.toFixed(1)}" y="${H-10}" text-anchor="middle">${i+1}</text>`;
    }).join('')}
  </svg>`;
}
function compactCategoryBreakdown(obj){
  const entries=Object.entries(obj||{}).filter(([,v])=>Number(v)!==0).sort((a,b)=>b[1]-a[1]);
  if(!entries.length)return `<div class="empty-inline">기록 없음</div>`;
  return `<div class="summary-category-list">${entries.map(([k,v])=>`<div><span>${esc(k)}</span><strong class="summary-category-amount">${won(v)}</strong></div>`).join('')}</div>`;
}
function annualDomainMeta(domain){
  if(domain==='income') return {label:'수입',positiveGood:true};
  if(domain==='fixed') return {label:'기본지출',positiveGood:false};
  return {label:'변동지출',positiveGood:false};
}
function annualDomainRows(domain,month){
  if(domain==='income') return state.incomes[month]||[];
  if(domain==='fixed') return state.fixedExpenses[month]||[];
  return state.variableExpenses.filter(x=>monthOf(x.date)===month);
}
function annualDomainCategories(domain,year){
  const active=domain==='income'?incomeCategories():(domain==='fixed'?fixedCategories():['고정','생활비','식비','이벤트']);
  const seen=new Set(active),out=[...active];
  for(let i=1;i<=12;i++){
    const month=`${year}-${pad(i)}`;
    annualDomainRows(domain,month).forEach(r=>{
      const c=String(r.category||'미분류');
      if(c&&!seen.has(c)){seen.add(c);out.push(c);}
    });
  }
  return out;
}
function annualCategoryMonthValue(domain,month,category){
  const rows=annualDomainRows(domain,month).filter(x=>(x.category||'미분류')===category);
  if(domain==='variable') return rows.reduce((a,b)=>a+effectiveExpenseAmount(b),0);
  return rows.reduce((a,b)=>a+Number(b.amount||0),0);
}
function annualCategorySeries(domain,category,year){
  return Array.from({length:12},(_,i)=>{
    const month=`${year}-${pad(i+1)}`;
    return {month,value:annualCategoryMonthValue(domain,month,category)};
  });
}
function annualCategoryStats(domain,category,year){
  const series=annualCategorySeries(domain,category,year);
  const total=series.reduce((a,b)=>a+b.value,0);
  const active=series.filter(x=>x.value!==0);
  const avg=active.length?total/active.length:0;
  const peak=active.length?[...active].sort((a,b)=>b.value-a.value)[0]:null;
  const prevYear=String(Number(year)-1);
  const prevSeries=annualCategorySeries(domain,category,prevYear);
  const prevTotal=prevSeries.reduce((a,b)=>a+b.value,0);
  const diff=total-prevTotal;
  const pct=prevTotal>0?(diff/prevTotal*100):null;
  return {series,total,activeMonths:active.length,avg,peak,prevYear,prevTotal,diff,pct};
}
function annualCategoryCompareMarkup(stats,positiveGood){
  if(stats.prevTotal<=0){
    return `<span class="annual-cat-compare neutral">전년 데이터 없음</span>`;
  }
  const up=stats.diff>=0;
  const good=positiveGood?up:!up;
  return `<span class="annual-cat-compare ${good?'good':'warn'}">${stats.prevYear}년 대비 ${up?'+':'-'}${Math.abs(stats.pct).toFixed(1)}%</span>`;
}
function annualCategoryTrendSvg(stats){
  const vals=stats.series.map(x=>x.value);
  const max=Math.max(1,...vals);
  const W=960,H=230,left=38,right=30,top=44,bottom=36;
  const plotH=H-top-bottom;
  const step=(W-left-right)/11;
  const points=stats.series.map((p,i)=>{
    const x=left+i*step;
    const y=top+plotH-(p.value/max)*plotH;
    return {x,y,value:p.value,month:i+1};
  });
  const path=points.map((p,i)=>`${i?'L':'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  return `<svg class="annual-category-trend" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="12개월 월별 추이">
    <line x1="${left}" y1="${top+plotH}" x2="${W-right}" y2="${top+plotH}" class="axis"/>
    <path d="${path}" class="annual-cat-line"/>
    ${points.map(p=>`<g class="annual-cat-point">
      <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5"/>
      <text class="annual-cat-value" x="${p.x.toFixed(1)}" y="${Math.max(16,p.y-12).toFixed(1)}" text-anchor="middle">${p.value?compactWon(p.value):'0'}</text>
      <text class="annual-cat-month" x="${p.x.toFixed(1)}" y="${H-9}" text-anchor="middle">${p.month}월</text>
      <title>${p.month}월 ${won(p.value)}</title>
    </g>`).join('')}
  </svg>`;
}
function annualCategoryMonthGrid(stats){
  return `<div class="annual-category-month-grid">${stats.series.map((p,i)=>`<div class="${p.value===0?'zero':''}"><span>${i+1}월</span><strong title="${won(p.value)}">${compactWon(p.value)}</strong></div>`).join('')}</div>`;
}
function annualCategoryAccordion(domain,year){
  const meta=annualDomainMeta(domain);
  const cats=annualDomainCategories(domain,year);
  const rows=cats.map(category=>{
    const stats=annualCategoryStats(domain,category,year);
    const key=`${domain}::${category}`;
    const open=expandedSummaryCategory===key;
    return `<div class="annual-category-item ${open?'open':''}">
      <button type="button" class="annual-category-toggle" data-key="${esc(key)}" aria-expanded="${open}">
        <span class="annual-category-name">${esc(category)}</span>
        <span class="annual-category-year-total"><span>${year} 합계</span><strong>${won(stats.total)}</strong></span>
        ${annualCategoryCompareMarkup(stats,meta.positiveGood)}
        <span class="chevron">${open?'⌃':'⌄'}</span>
      </button>
      ${open?`<div class="annual-category-detail">
        <div class="annual-category-kpis">
          <div><span>${year} 총합</span><strong>${won(stats.total)}</strong></div>
          <div><span>기록월 평균</span><strong>${won(stats.avg)}</strong><small>${stats.activeMonths}개 기록월</small></div>
          <div><span>${stats.prevYear} 총합</span><strong>${won(stats.prevTotal)}</strong><small>${stats.prevTotal>0?(stats.diff>=0?'+':'-')+won(Math.abs(stats.diff)):'비교 데이터 없음'}</small></div>
          <div><span>최대 월</span><strong>${stats.peak?Number(stats.peak.month.slice(5))+'월':'-'}</strong><small>${stats.peak?won(stats.peak.value):'기록 없음'}</small></div>
        </div>
        <div class="annual-category-chart-wrap">${annualCategoryTrendSvg(stats)}</div>
        
      </div>`:''}
    </div>`;
  }).join('');
  return `<div class="annual-category-domain">
    <div class="annual-category-domain-head"><h3>${meta.label}</h3><p>${year}년 대분류별 총합과 월별 변화</p></div>
    <div class="annual-category-list">${rows||'<div class="empty">기록이 없습니다.</div>'}</div>
  </div>`;
}

function renderSummary(){
  const year=String(selectedMonth||currentMonth).slice(0,4);
  const months=Array.from({length:12},(_,i)=>`${year}-${pad(i+1)}`);
  const stats=months.map(m=>({month:m,...monthStats(m)}));
  const income=stats.reduce((a,b)=>a+b.income,0);
  const fixed=stats.reduce((a,b)=>a+b.fixed,0);
  const variable=stats.reduce((a,b)=>a+b.variable,0);
  const expense=fixed+variable,net=income-expense;
  const active=stats.filter(s=>s.income||s.fixed||s.variable);
  const avgExpense=active.length?expense/active.length:0;
  const savingsRate=income>0?net/income*100:0;
  const peak=active.length?[...active].sort((a,b)=>(b.fixed+b.variable)-(a.fixed+a.variable))[0]:null;

  app.innerHTML=`<div class="grid cols-4 annual-kpis">
    <div class="card metric positive"><div class="metric-label">${year} 총수입</div><div class="metric-value">${won(income)}</div><div class="metric-foot">${active.length}개 기록월</div></div>
    <div class="card metric negative"><div class="metric-label">${year} 총지출</div><div class="metric-value">${won(expense)}</div><div class="metric-foot">기본 ${won(fixed)} · 변동 ${won(variable)}</div></div>
    <div class="card metric ${net>=0?'positive':'negative'}"><div class="metric-label">순현금흐름</div><div class="metric-value">${won(net)}</div><div class="metric-foot">저축률 ${savingsRate.toFixed(1)}%</div></div>
    <div class="card metric"><div class="metric-label">기록월 평균 지출</div><div class="metric-value">${won(avgExpense)}</div><div class="metric-foot">${peak?`최대 ${Number(peak.month.slice(5))}월 ${won(peak.fixed+peak.variable)}`:'기록 없음'}</div></div>
  </div>
  <div class="grid cols-2 equal-cols-2 section-gap annual-visuals">
    <div class="card"><div class="card-head"><div><h2>월별 수입 vs 지출</h2><p>막대를 통해 월별 규모 차이를 빠르게 비교합니다.</p></div><div class="chart-legend"><span class="income-key">수입</span><span class="expense-key">지출</span></div></div><div class="annual-main-chart-wrap"><div class="annual-main-tooltip" hidden></div><div class="chart-scroll">${summaryBarSvg(stats)}</div></div></div>
    <div class="card"><div class="card-head"><div><h2>월별 순현금흐름</h2><p>0선 위는 흑자, 아래는 적자입니다.</p></div></div><div class="annual-main-chart-wrap"><div class="annual-main-tooltip" hidden></div><div class="chart-scroll">${summaryNetSvg(stats)}</div></div></div>
  </div>
  <div class="card section-gap"><div class="card-head"><div><h2>월별 상세 요약</h2><p>월을 눌러 수입·기본지출·변동지출의 대분류를 한 번에 확인합니다.</p></div></div>
    <div class="annual-month-list">${stats.map(s=>{
      const opened=expandedSummaryMonth===s.month;
      const has=s.income||s.fixed||s.variable;
      const inc=groupedCategoryTotals(state.incomes,s.month),fix=groupedCategoryTotals(state.fixedExpenses,s.month),vari=variableCategoryTotals(s.month);
      return `<div class="annual-month-item ${opened?'open':''}">
        <button type="button" class="annual-month-toggle" data-month="${s.month}" aria-expanded="${opened}">
          <span class="month-name">${Number(s.month.slice(5))}월</span>
          <span class="month-mini income-mini">수입 ${won(s.income)}</span>
          <span class="month-mini expense-mini">지출 ${won(s.fixed+s.variable)}</span>
          <strong class="${s.income-s.fixed-s.variable>=0?'positive-text':'negative-text'}">${won(s.income-s.fixed-s.variable)}</strong>
          <span class="chevron">${opened?'⌃':'⌄'}</span>
        </button>
        ${opened?`<div class="annual-month-detail">
          <div class="summary-detail-block income-block"><div class="summary-block-head"><h3>수입</h3><strong>${won(s.income)}</strong></div>${compactCategoryBreakdown(inc)}</div>
          <div class="summary-detail-block fixed-block"><div class="summary-block-head"><h3>기본지출</h3><strong>${won(s.fixed)}</strong></div>${compactCategoryBreakdown(fix)}</div>
          <div class="summary-detail-block variable-block"><div class="summary-block-head"><h3>변동지출</h3><strong>${won(s.variable)}</strong></div>${compactCategoryBreakdown(vari)}</div>
        </div>`:''}
      </div>`;
    }).join('')}</div>
  </div>
  <div class="card section-gap">
    <div class="card-head"><div><h2>대분류별 상세 요약</h2><p>대분류를 펼쳐 연간 총합, 12개월 변화, 기록월 평균과 전년 동기 비교를 확인합니다.</p></div></div>
    <div class="annual-category-domains">
      ${annualCategoryAccordion('income',year)}
      ${annualCategoryAccordion('fixed',year)}
      ${annualCategoryAccordion('variable',year)}
    </div>
  </div>`;
  document.querySelectorAll('.annual-month-toggle').forEach(b=>b.onclick=()=>{
    expandedSummaryMonth=expandedSummaryMonth===b.dataset.month?'':b.dataset.month;
    renderSummary();
  });
  document.querySelectorAll('.annual-category-toggle').forEach(b=>b.onclick=()=>{
    expandedSummaryCategory=expandedSummaryCategory===b.dataset.key?'':b.dataset.key;
    renderSummary();
  });
}
function incomeCategories(){return state.settings.incomeCategories||['남편','아내','자녀','공통'];}
function fixedCategories(){return state.settings.fixedCategories||['주거','보험','헌금'];}
function categoriesForDisplay(list,active){
  const seen=new Set(active||[]);
  const out=[...(active||[])];
  (list||[]).forEach(x=>{const c=String(x.category||'').trim();if(c&&!seen.has(c)){seen.add(c);out.push(c);}});
  return out;
}
function recordCreatedMs(x){return Math.max(parseTime(x&&x.createdAt),0);}
function sortSimpleRecords(list,mode,activeCategories){
  const order=new Map((activeCategories||[]).map((c,i)=>[c,i]));
  return [...(list||[])].sort((a,b)=>{
    if(mode==='registered'){
      const d=recordCreatedMs(b)-recordCreatedMs(a);
      return d||String(b.id||'').localeCompare(String(a.id||''));
    }
    const ai=order.has(a.category)?order.get(a.category):999;
    const bi=order.has(b.category)?order.get(b.category):999;
    if(ai!==bi)return ai-bi;
    const c=String(a.category||'').localeCompare(String(b.category||''),'ko');
    if(c)return c;
    const d=recordCreatedMs(b)-recordCreatedMs(a);
    return d||String(b.id||'').localeCompare(String(a.id||''));
  });
}

function activeDataMonths(groupKey,year){
  const grouped=state[groupKey]||{};
  return Array.from({length:12},(_,i)=>`${year}-${pad(i+1)}`).filter(month=>(grouped[month]||[]).length>0);
}
function categoryMonthlyAverage(groupKey,category,year){
  const grouped=state[groupKey]||{},months=activeDataMonths(groupKey,year);
  if(!months.length)return 0;
  const total=months.reduce((sum,month)=>sum+(grouped[month]||[]).filter(x=>(x.category||'')===category).reduce((a,b)=>a+Number(b.amount||0),0),0);
  return total/months.length;
}
function totalMonthlyAverage(groupKey,year){
  const grouped=state[groupKey]||{},months=activeDataMonths(groupKey,year);
  if(!months.length)return 0;
  const total=months.reduce((sum,month)=>sum+(grouped[month]||[]).reduce((a,b)=>a+Number(b.amount||0),0),0);
  return total/months.length;
}
function avgBadge(value,avg,positiveGood){
  if(avg===0) return `<span class="avg-badge neutral">기록월 없음</span>`;
  const diff=value-avg, pct=Math.round(Math.abs(diff)/avg*100);
  const higher=diff>=0;
  const good=positiveGood?higher:!higher;
  return `<span class="avg-badge ${good?'good':'warn'}">기록월 평균보다 ${pct}% ${higher?'높음':'낮음'}</span>`;
}
function categoryColorIndex(groupKey,category){
  const cats=groupKey==='incomes'?incomeCategories():(groupKey==='fixedExpenses'?fixedCategories():[]);
  const idx=cats.indexOf(category);
  return (idx>=0?idx:0)%8;
}
function categoryColorClass(groupKey,category){
  return `category-color-${categoryColorIndex(groupKey,category)}`;
}

function categorySummaryCards(list,categories,groupKey,positiveGood){
  const year=selectedMonth.slice(0,4);
  return `<div class="category-summary-grid auto-category-grid category-count-${Math.min(8,Math.max(1,categories.length))}">${categories.map(c=>{
    const v=list.filter(x=>(x.category||'')===c).reduce((a,b)=>a+Number(b.amount||0),0);
    const avg=categoryMonthlyAverage(groupKey,c,year);
    return `<div class="category-summary-item ${categoryColorClass(groupKey,c)}"><span>${c}</span><strong>${won(v)}</strong>${avgBadge(v,avg,positiveGood)}<small>기록월 평균 ${won(avg)}</small></div>`;
  }).join('')}</div>`;
}
function categoryTabs(name,categories,selected){
  const count=Math.min(8,Math.max(1,categories.length));
  return `<div class="segmented category-entry-tabs category-count-${count}">${categories.map(c=>`<button type="button" class="${c===selected?'active':''}" data-category="${esc(c)}">${esc(c)}</button>`).join('')}</div><input type="hidden" name="${name}" value="${esc(selected)}">`;
}

function trendSeriesValue(domain,month,category){
  if(domain==='incomes'){
    return (state.incomes[month]||[]).filter(x=>(x.category||'미분류')===category).reduce((a,b)=>a+Number(b.amount||0),0);
  }
  if(domain==='fixedExpenses'){
    return (state.fixedExpenses[month]||[]).filter(x=>(x.category||'미분류')===category).reduce((a,b)=>a+Number(b.amount||0),0);
  }
  return state.variableExpenses.filter(x=>monthOf(x.date)===month&&(x.category||'미분류')===category).reduce((a,b)=>a+effectiveExpenseAmount(b),0);
}
function trendCategoryLabel(domain,c){
  if(domain==='variableExpenses'&&c==='고정')return '카드고정지출';
  return c;
}
function categoryTrendChart(domain,categories,year,currentMonth,title){
  const months=Array.from({length:12},(_,i)=>`${year}-${pad(i+1)}`);
  const series=(categories||[]).map((category,si)=>({
    category,label:trendCategoryLabel(domain,category),
    values:months.map(month=>trendSeriesValue(domain,month,category)),si
  }));
  const max=Math.max(1,...series.flatMap(s=>s.values));
  const W=900,H=280,left=40,right=24,top=24,bottom=36,plotH=H-top-bottom,step=(W-left-right)/11;
  const selectedIndex=Math.max(0,Math.min(11,Number(currentMonth.slice(5,7))-1));
  const selectedX=left+selectedIndex*step;
  const bandW=Math.min(step*.72,64);
  const bandMin=6;
  const bandMax=W-bandW-6;
  const bandX=Math.min(Math.max(bandMin,selectedX-bandW/2),bandMax);
  const paths=series.map(s=>{
    const pts=s.values.map((v,i)=>({x:left+i*step,y:top+plotH-(v/max)*plotH,v,i}));
    const d=pts.map((p,i)=>`${i?'L':'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    return `<path d="${d}" class="category-trend-line trend-series-${s.si%8}"/>
      ${pts.map(p=>`<g class="category-trend-hit" data-tooltip-category="${esc(s.label)}" data-tooltip-month="${p.i+1}월" data-tooltip-value="${won(p.v)}">
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="11" class="category-trend-hit-area"/>
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.i===selectedIndex?5.2:3.2}" class="category-trend-point trend-series-${s.si%8} ${p.i===selectedIndex?'selected':''}"/>
      </g>`).join('')}`;
  }).join('');
  return `<div class="card category-trend-card">
    <div class="card-head"><div><h2>${esc(title)}</h2><p>1~12월 대분류별 월간 추이 · 선택월은 강조 표시</p></div></div>
    <div class="category-trend-legend">${series.map(s=>`<span class="trend-series-${s.si%8}"><i></i>${esc(s.label)}</span>`).join('')}</div>
    <div class="category-trend-tooltip" role="status" aria-live="polite" hidden></div>
    <div class="category-trend-scroll">
    <svg class="category-trend-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(title)}">
      <rect x="${bandX.toFixed(1)}" y="${Math.max(4,top-10)}" width="${bandW.toFixed(1)}" height="${plotH+20}" rx="8" class="selected-month-band"/>
      <line x1="${left}" y1="${top+plotH}" x2="${W-right}" y2="${top+plotH}" class="axis"/>
      ${paths}
      ${months.map((m,i)=>`<text x="${(left+i*step).toFixed(1)}" y="${H-10}" text-anchor="middle" class="${i===selectedIndex?'selected-month-label':''}">${i+1}월</text>`).join('')}
    </svg>
    </div>
  </div>`;
}


function bindAnnualMainTooltips(){
  document.querySelectorAll('.annual-main-chart-wrap').forEach(wrap=>{
    const tooltip=wrap.querySelector('.annual-main-tooltip');
    if(!tooltip)return;
    const show=(hit,e)=>{
      tooltip.innerHTML=`<span>${esc(hit.dataset.tooltipLabel||'')}</span><strong>${esc(hit.dataset.tooltipValue||'')}</strong>`;
      tooltip.hidden=false;
      const rect=wrap.getBoundingClientRect();
      const x=Math.min(Math.max(8,e.clientX-rect.left+12),Math.max(8,rect.width-tooltip.offsetWidth-8));
      const y=Math.max(8,e.clientY-rect.top-tooltip.offsetHeight-10);
      tooltip.style.left=`${x}px`;
      tooltip.style.top=`${y}px`;
    };
    wrap.querySelectorAll('.annual-main-hit').forEach(hit=>{
      hit.addEventListener('pointerenter',e=>show(hit,e));
      hit.addEventListener('pointermove',e=>show(hit,e));
      hit.addEventListener('pointerleave',e=>{if(e.pointerType!=='touch')tooltip.hidden=true;});
      hit.addEventListener('click',e=>{e.stopPropagation();show(hit,e);});
    });
    wrap.addEventListener('pointerleave',e=>{if(e.pointerType!=='touch')tooltip.hidden=true;});
  });
}

function bindCategoryTrendTooltips(){
  document.querySelectorAll('.category-trend-card').forEach(card=>{
    const tooltip=card.querySelector('.category-trend-tooltip');
    if(!tooltip)return;
    const hits=card.querySelectorAll('.category-trend-hit');

    const show=(hit,clientX,clientY)=>{
      const category=hit.dataset.tooltipCategory||'';
      const month=hit.dataset.tooltipMonth||'';
      const value=hit.dataset.tooltipValue||'';
      tooltip.innerHTML=`<strong>${esc(category)}</strong><span>${esc(month)}</span><b>${esc(value)}</b>`;
      tooltip.hidden=false;

      const rect=card.getBoundingClientRect();
      const x=Math.min(Math.max(10,clientX-rect.left+12),Math.max(10,rect.width-tooltip.offsetWidth-10));
      const y=Math.max(8,clientY-rect.top-tooltip.offsetHeight-12);
      tooltip.style.left=`${x}px`;
      tooltip.style.top=`${y}px`;
    };
    const hide=()=>{tooltip.hidden=true;};

    hits.forEach(hit=>{
      hit.addEventListener('pointerenter',e=>show(hit,e.clientX,e.clientY));
      hit.addEventListener('pointermove',e=>show(hit,e.clientX,e.clientY));
      hit.addEventListener('pointerleave',e=>{
        if(e.pointerType!=='touch')hide();
      });
      hit.addEventListener('click',e=>{
        e.stopPropagation();
        show(hit,e.clientX,e.clientY);
      });
    });
    card.addEventListener('pointerleave',e=>{
      if(e.pointerType!=='touch')hide();
    });
  });
}

function renderIncome(){
  const raw=state.incomes[selectedMonth]||[];
  const cats=incomeCategories();
  const list=sortSimpleRecords(raw,incomeSortMode,cats);
  const displayCats=categoriesForDisplay(raw,cats);
  const total=raw.reduce((a,b)=>a+Number(b.amount||0),0);
  const year=selectedMonth.slice(0,4),totalAvg=totalMonthlyAverage('incomes',year);
  const defaultCat=preferredEntryTab('incomeCategory',cats)||cats[0]||'공통';
  app.innerHTML=`<div class="grid cols-2 entry-metric-row">
    <div class="card"><div class="card-head"><div><h2>${selectedMonth} 수입 등록</h2><p>대분류를 선택한 뒤 항목과 금액을 입력합니다.</p></div></div>
      <form id="incomeForm" class="simple-entry-form" novalidate>
        <div class="field full"><label>대분류</label>${categoryTabs('category',cats,defaultCat)}</div>
        <div class="form-grid section-gap"><div class="field"><label>수입 항목</label><input name="name" placeholder="예: 급여, 상여금" required></div><div class="field"><label>금액</label><input name="amount" inputmode="numeric" required></div></div>
        <div class="button-row"><button class="btn primary">추가</button></div>
      </form>
    </div>
    <div class="card metric positive"><div class="metric-label">이번 달 총수입</div><div class="metric-value">${won(total)}</div>${avgBadge(total,totalAvg,true)}<div class="metric-foot">기록월 평균 ${won(totalAvg)} · ${raw.length}개 항목</div></div>
  </div>
  <div class="grid cols-2 equal-cols-2 summary-trend-side-row section-gap">
    <div class="card category-summary-section income-summary-section"><div class="card-head"><div><h2>분류별 수입</h2><p>현재 월 합계와 데이터가 입력된 월 기준 평균을 비교합니다.</p></div></div>${categorySummaryCards(raw,displayCats,'incomes',true)}</div>
    ${categoryTrendChart('incomes',displayCats,year,selectedMonth,'수입 대분류 월별 추이')}
  </div>
  <div class="card section-gap"><div class="card-head simple-list-head"><div><h2>수입 세부내역</h2><p>분류별 또는 실제 등록시간 기준으로 볼 수 있습니다.</p></div><div class="segmented simple-sort"><button type="button" class="${incomeSortMode==='category'?'active':''}" data-sort="category">분류별</button><button type="button" class="${incomeSortMode==='registered'?'active':''}" data-sort="registered">등록 최신</button></div></div>${editorRows(list,'income')}</div>`;

  const form=document.getElementById('incomeForm');
  form.querySelectorAll('.category-entry-tabs button').forEach(b=>b.onclick=()=>{
    form.elements.category.value=b.dataset.category;
    rememberEntryTab('incomeCategory',b.dataset.category);
    form.querySelectorAll('.category-entry-tabs button').forEach(x=>x.classList.toggle('active',x===b));
  });
  form.onsubmit=e=>{
    e.preventDefault();
    const f=new FormData(e.target),category=String(f.get('category')||defaultCat),name=String(f.get('name')||'').trim(),amount=parseAmount(f.get('amount'));
    if(!name){toast('수입 항목을 입력해 주세요.');e.target.elements.name.focus();return;}
    if(!Number.isFinite(amount)||amount<0){toast('올바른 수입 금액을 입력해 주세요.');e.target.elements.amount.focus();return;}
    const now=new Date().toISOString();
    const rec={id:id(),month:selectedMonth,category,name,amount,createdAt:now,updatedAt:now};
    state.incomes[selectedMonth]=[...(state.incomes[selectedMonth]||[]),rec];
    formDirty=false;saveLocalOnly();queuePendingUpserts('incomes',[rec]);flushPendingUpserts().catch(console.error);renderIncome();
  };
  document.querySelectorAll('.simple-sort button').forEach(b=>b.onclick=()=>{incomeSortMode=b.dataset.sort;renderIncome();});
  bindEditor('income');
}
function renderFixed(){
  const raw=state.fixedExpenses[selectedMonth]||[];
  const cats=fixedCategories();
  const list=sortSimpleRecords(raw,fixedSortMode,cats);
  const displayCats=categoriesForDisplay(raw,cats);
  const total=raw.reduce((a,b)=>a+Number(b.amount||0),0);
  const year=selectedMonth.slice(0,4),totalAvg=totalMonthlyAverage('fixedExpenses',year);
  const defaultCat=preferredEntryTab('fixedCategory',cats)||cats[0]||'주거';
  app.innerHTML=`<div class="grid cols-2 entry-metric-row">
    <div class="card"><div class="card-head"><div><h2>${selectedMonth} 기본지출 추가</h2><p>현금으로 나가는 고정지출입니다. 대분류를 선택해 등록하세요.</p></div><button class="btn small" id="copyFixedBtn" type="button">전월 기본지출 복사</button></div>
      <form id="fixedForm" class="simple-entry-form" novalidate>
        <div class="field full"><label>대분류</label>${categoryTabs('category',cats,defaultCat)}</div>
        <div class="form-grid section-gap"><div class="field"><label>지출 항목</label><input name="name" placeholder="예: 관리비, 보험료" required></div><div class="field"><label>금액</label><input name="amount" inputmode="numeric" required></div></div>
        <div class="button-row"><button class="btn primary">추가</button></div>
      </form>
    </div>
    <div class="card metric negative"><div class="metric-label">이번 달 기본지출</div><div class="metric-value">${won(total)}</div>${avgBadge(total,totalAvg,false)}<div class="metric-foot">기록월 평균 ${won(totalAvg)} · ${raw.length}개 항목</div></div>
  </div>
  <div class="grid cols-2 equal-cols-2 summary-trend-side-row section-gap">
    <div class="card category-summary-section fixed-summary-section"><div class="card-head"><div><h2>분류별 기본지출</h2><p>현재 월 합계와 데이터가 입력된 월 기준 평균을 비교합니다.</p></div></div>${categorySummaryCards(raw,displayCats,'fixedExpenses',false)}</div>
    ${categoryTrendChart('fixedExpenses',displayCats,year,selectedMonth,'기본지출 대분류 월별 추이')}
  </div>
  <div class="card section-gap"><div class="card-head simple-list-head"><div><h2>기본지출 세부내역</h2><p>분류별 또는 실제 등록시간 기준으로 볼 수 있습니다.</p></div><div class="segmented simple-sort"><button type="button" class="${fixedSortMode==='category'?'active':''}" data-sort="category">분류별</button><button type="button" class="${fixedSortMode==='registered'?'active':''}" data-sort="registered">등록 최신</button></div></div>${editorRows(list,'fixed')}</div>`;

  const form=document.getElementById('fixedForm');
  form.querySelectorAll('.category-entry-tabs button').forEach(b=>b.onclick=()=>{
    form.elements.category.value=b.dataset.category;
    rememberEntryTab('fixedCategory',b.dataset.category);
    form.querySelectorAll('.category-entry-tabs button').forEach(x=>x.classList.toggle('active',x===b));
  });
  form.onsubmit=e=>{
    e.preventDefault();
    const f=new FormData(e.target),category=String(f.get('category')||defaultCat),name=String(f.get('name')||'').trim(),amount=parseAmount(f.get('amount'));
    if(!name){toast('지출 항목을 입력해 주세요.');e.target.elements.name.focus();return;}
    if(!Number.isFinite(amount)||amount<0){toast('올바른 금액을 입력해 주세요.');e.target.elements.amount.focus();return;}
    const now=new Date().toISOString();
    const rec={id:id(),month:selectedMonth,category,name,amount,createdAt:now,updatedAt:now};
    state.fixedExpenses[selectedMonth]=[...(state.fixedExpenses[selectedMonth]||[]),rec];
    formDirty=false;saveLocalOnly();queuePendingUpserts('fixedExpenses',[rec]);flushPendingUpserts().catch(console.error);renderFixed();
  };
  const cfb=document.getElementById('copyFixedBtn');
  if(cfb)cfb.onclick=()=>{
    const prev=previousMonth(selectedMonth),src=state.fixedExpenses[prev]||[];
    if(!src.length){alert(`${prev}에 기본지출이 없습니다.`);return;}
    if(!confirm(`${prev} 기본지출 ${src.length}개를 가져올까요?`))return;
    const cur=state.fixedExpenses[selectedMonth]||[],now=new Date().toISOString();
    const add=src.filter(x=>!cur.some(c=>c.name===x.name&&c.category===x.category)).map(x=>({id:id(),category:x.category||defaultCat,name:x.name,amount:Number(x.amount)||0,createdAt:now,updatedAt:now}));
    add.forEach(x=>x.month=selectedMonth);
    state.fixedExpenses[selectedMonth]=[...cur,...add];saveLocalOnly();queuePendingUpserts('fixedExpenses',add);flushPendingUpserts().catch(console.error);renderFixed();toast(`${add.length}개 항목을 복사했습니다.`);
  };
  document.querySelectorAll('.simple-sort button').forEach(b=>b.onclick=()=>{fixedSortMode=b.dataset.sort;renderFixed();});
  bindEditor('fixed');
}
function editorRows(list,type){
  if(!list.length)return `<div class="empty">등록된 항목이 없습니다.</div>`;
  return `<div class="simple-record-list">${list.map(x=>`<div class="simple-record-row ${categoryColorClass(type==='income'?'incomes':'fixedExpenses',x.category||'미분류')}">
    <span class="pill ${type==='income'?'income-pill':'fixed-pill'}">${esc(x.category||'미분류')}</span>
    <div class="simple-record-info"><strong>${esc(x.name)}</strong></div>
    <strong class="simple-record-amount">${won(x.amount)}</strong>
    <div class="simple-record-actions"><button class="btn small edit-simple" data-id="${x.id}" data-type="${type}" type="button">수정</button><button class="btn small danger delete-edit" data-id="${x.id}" type="button">삭제</button></div>
  </div>`).join('')}</div>`;
}
function bindEditor(type){
  document.querySelectorAll('.edit-simple').forEach(b=>b.onclick=()=>renderSimpleRecordEdit(type,b.dataset.id));
  document.querySelectorAll('.delete-edit').forEach(b=>b.onclick=()=>{
    if(!confirm('이 항목을 삭제할까요?'))return;
    const rid=b.dataset.id;
    markLocalDeleted(type==='income'?'incomes':'fixedExpenses',rid);
    if(type==='income')state.incomes[selectedMonth]=(state.incomes[selectedMonth]||[]).filter(x=>x.id!==rid);
    else state.fixedExpenses[selectedMonth]=(state.fixedExpenses[selectedMonth]||[]).filter(x=>x.id!==rid);
    saveLocalOnly();
    flushPendingDeletes().catch(console.error);
    type==='income'?renderIncome():renderFixed();
  });
}
function renderSimpleRecordEdit(type,recordId){
  const list=type==='income'?(state.incomes[selectedMonth]||[]):(state.fixedExpenses[selectedMonth]||[]);
  const x=list.find(r=>r.id===recordId);
  if(!x){type==='income'?renderIncome():renderFixed();return;}
  const cats=type==='income'?incomeCategories():fixedCategories();
  const title=type==='income'?'수입 항목 수정':'기본지출 항목 수정';
  app.innerHTML=`<div class="card simple-edit-card"><div class="card-head"><div><h2>${title}</h2><p>대분류, 항목명, 금액을 모두 변경할 수 있습니다.</p></div></div>
    <form id="simpleRecordEditForm" novalidate>
      <div class="field full"><label>대분류</label>${categoryTabs('category',cats,x.category||cats[0])}</div>
      <div class="form-grid section-gap">
        <div class="field"><label>항목</label><input name="name" value="${esc(x.name||'')}"></div>
        <div class="field"><label>금액</label><input name="amount" inputmode="numeric" value="${Number(x.amount)||0}"></div>
      </div>
      <div class="button-row"><button class="btn" id="cancelSimpleEdit" type="button">취소</button><button class="btn primary" type="submit">수정 저장</button></div>
    </form>
  </div>`;
  const form=document.getElementById('simpleRecordEditForm');
  bindMoneyInputs();
  form.querySelectorAll('.category-entry-tabs button').forEach(b=>b.onclick=()=>{
    form.elements.category.value=b.dataset.category;
    form.querySelectorAll('.category-entry-tabs button').forEach(q=>q.classList.toggle('active',q===b));
  });
  document.getElementById('cancelSimpleEdit').onclick=()=>type==='income'?renderIncome():renderFixed();
  form.onsubmit=e=>{
    e.preventDefault();
    const f=new FormData(form),category=String(f.get('category')||cats[0]),name=String(f.get('name')||'').trim(),amount=parseAmount(f.get('amount'));
    if(!name||!Number.isFinite(amount)||amount<0){toast('항목명과 금액을 확인해 주세요.');return;}
    Object.assign(x,{category,name,amount,month:selectedMonth,updatedAt:new Date().toISOString()});
    formDirty=false;saveLocalOnly();
    queuePendingUpserts(type==='income'?'incomes':'fixedExpenses',[x]);
    flushPendingUpserts().catch(console.error);
    toast('수정했습니다.');
    type==='income'?renderIncome():renderFixed();
  };
}

function activeCardMonths(year){
  const months=new Set(
    (state.cardRecords||[])
      .map(x=>normalizeMonthKey(x.month))
      .filter(m=>m && m.startsWith(year+'-'))
  );
  return [...months].sort();
}
function cardMonthlyAverage(year,predicate=()=>true){
  const months=activeCardMonths(year);
  if(!months.length)return 0;
  const total=months.reduce((sum,m)=>{
    return sum+(state.cardRecords||[])
      .filter(x=>normalizeMonthKey(x.month)===m && predicate(x))
      .reduce((a,b)=>a+Number(b.amount||0),0);
  },0);
  return total/months.length;
}

async function remoteUpsertCardRecord(record){
  if(!apiConfigured()) return false;
  const payload=btoa(unescape(encodeURIComponent(JSON.stringify(record))));
  const res=await jsonpRequest({action:'upsertCardRecord',payload64:payload});
  if(!res||!res.ok) throw new Error((res&&res.error)||'카드 기록 저장 실패');
  return true;
}
async function remoteDeleteCardRecord(recordId){
  if(!apiConfigured()) return false;
  const res=await jsonpRequest({action:'deleteCardRecord',id:String(recordId)});
  if(!res||!res.ok) throw new Error((res&&res.error)||'카드 기록 삭제 실패');
  return true;
}

function renderCards(){
  const rows=state.cardRecords.filter(x=>x.month===selectedMonth);
  const total=rows.reduce((a,b)=>a+Number(b.amount||0),0);
  const husbandTotal=rows.filter(x=>x.owner==='남편'||x.card==='남편카드').reduce((a,b)=>a+Number(b.amount||0),0);
  const wifeTotal=rows.filter(x=>x.owner==='아내'||x.card==='아내카드').reduce((a,b)=>a+Number(b.amount||0),0);
  const cardYear=selectedMonth.slice(0,4);
  const totalCardAvg=cardMonthlyAverage(cardYear);
  const husbandCardAvg=cardMonthlyAverage(cardYear,x=>x.owner==='남편'||x.card==='남편카드');
  const wifeCardAvg=cardMonthlyAverage(cardYear,x=>x.owner==='아내'||x.card==='아내카드');
  const husbandCards=state.settings.husbandCards||[];
  const wifeCards=state.settings.wifeCards||[];
  const defaultOwner=preferredEntryTab('cardOwner',['남편','아내'])||'남편';
  const defaultType=husbandCards[0]||'';
  app.innerHTML=`
    <div class="grid cols-3 card-totals">
      <div class="card metric"><div class="metric-label">카드값 총합</div><div class="metric-value">${won(total)}</div>${avgBadge(total,totalCardAvg,false)}<div class="metric-foot">기록월 평균 ${won(totalCardAvg)}</div></div>
      <div class="card metric"><div class="metric-label">남편카드값 총합</div><div class="metric-value">${won(husbandTotal)}</div>${avgBadge(husbandTotal,husbandCardAvg,false)}<div class="metric-foot">기록월 평균 ${won(husbandCardAvg)}</div></div>
      <div class="card metric"><div class="metric-label">아내카드값 총합</div><div class="metric-value">${won(wifeTotal)}</div>${avgBadge(wifeTotal,wifeCardAvg,false)}<div class="metric-foot">기록월 평균 ${won(wifeCardAvg)}</div></div>
    </div>
    <div class="grid cols-2 equal-cols-2 card-main-row section-gap">
      <div class="card">
        <div class="card-head"><div><h2>카드 청구 기록 추가</h2><p>해당 월에 청구된 카드 금액을 기록합니다. 실제 사용월과는 다를 수 있습니다.</p></div></div>
        <form id="cardForm" novalidate>
          <input type="hidden" name="owner" id="cardOwner" value="${defaultOwner}">
          <input type="hidden" name="cardType" id="cardType" value="${esc(defaultType)}">
          <div class="card-select-group">
            <div class="field-label">사용자</div>
            <div class="segmented owner-tabs" id="ownerTabs">
              <button type="button" class="active" data-owner="남편">남편카드</button>
              <button type="button" data-owner="아내">아내카드</button>
            </div>
          </div>
          <div class="card-select-group">
            <div class="field-label">카드 종류</div>
            <div class="card-type-tabs" id="cardTypeTabs"></div>
          </div>
          <div class="form-grid">
            <div class="field"><label>금액</label><input name="amount" type="number" min="0" inputmode="numeric" placeholder="예: 350000"></div>
            <div class="field"><label>기록명</label><input name="memo" placeholder="예: 8월 청구액"></div>
          </div>
          <div class="button-row"><button class="btn primary">기록 추가</button></div>
        </form>
      </div>
      <div class="card"><div class="card-head"><div><h2>이번 달 카드 청구 기록</h2><p>${rows.length}건의 청구·확인 기록</p></div></div>
        ${rows.length?`<div class="card-record-table">${rows.sort((a,b)=>String(b.id||'').localeCompare(String(a.id||''))).map(x=>`<div class="card-record-row">
          <div class="card-record-main"><span class="card-record-name">${esc((x.owner||'')+(x.cardType?' · '+x.cardType:''))}</span><span class="card-record-memo">${esc(x.memo||'-')}</span></div>
          <strong class="card-record-amount">${won(x.amount)}</strong>
          <div class="card-record-actions"><button type="button" class="btn small edit-card-record" data-id="${x.id}">수정</button><button type="button" class="btn small danger delete-card-record" data-id="${x.id}">삭제</button></div>
        </div>`).join('')}</div>`:`<div class="empty">등록된 카드 기록이 없습니다.</div>`}
      </div>
    </div>`;

  const ownerInput=document.getElementById('cardOwner');
  const typeInput=document.getElementById('cardType');
  const ownerTabs=document.getElementById('ownerTabs');
  const typeTabs=document.getElementById('cardTypeTabs');
  function renderTypeTabs(){
    const cards=ownerInput.value==='남편'?husbandCards:wifeCards;
    if(!cards.includes(typeInput.value)) typeInput.value=cards[0]||'';
    typeTabs.innerHTML=cards.length?cards.map(c=>`<button type="button" class="card-type-tab ${c===typeInput.value?'active':''}" data-type="${esc(c)}">${esc(c)}</button>`).join(''):`<div class="empty-inline">항목설정에서 카드 종류를 추가해 주세요.</div>`;
    typeTabs.querySelectorAll('button').forEach(b=>b.onclick=()=>{
      typeInput.value=b.dataset.type;
      typeTabs.querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b));
    });
  }
  ownerTabs.querySelectorAll('button').forEach(b=>b.onclick=()=>{
    ownerInput.value=b.dataset.owner;
    rememberEntryTab('cardOwner',b.dataset.owner);
    ownerTabs.querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b));
    typeInput.value='';
    renderTypeTabs();
  });
  renderTypeTabs();
  document.getElementById('cardForm').onsubmit=e=>{
    e.preventDefault();
    const f=new FormData(e.target);
    const owner=String(f.get('owner')||'').trim(),cardType=String(f.get('cardType')||'').trim(),amount=parseAmount(f.get('amount')),memo=String(f.get('memo')||'').trim();
    if(!owner){toast('남편카드 또는 아내카드를 선택해 주세요.');return;}
    if(!cardType){toast('카드 종류를 선택해 주세요.');return;}
    if(!Number.isFinite(amount)||amount<0){toast('올바른 카드 금액을 입력해 주세요.');e.target.elements.amount.focus();return;}
    const rec={id:id(),month:selectedMonth,owner,cardType,card:owner+'카드',amount,memo,createdAt:new Date().toISOString()};
    state.cardRecords.push(rec);
    formDirty=false;saveLocalOnly();renderCards();
    queuePendingUpserts('cardRecords',[rec]);
    flushPendingUpserts().catch(err=>{setSyncStatus('카드 청구 기록 저장 재시도 대기',false);console.error(err);});
  };

  document.querySelectorAll('.delete-card-record').forEach(b=>b.onclick=()=>{
    if(!confirm('이 카드 청구 기록을 삭제할까요?')) return;
    const rid=b.dataset.id;
    markLocalDeleted('cardRecords',rid);
    state.cardRecords=state.cardRecords.filter(x=>x.id!==rid);
    formDirty=false;saveLocalOnly();renderCards();
    flushPendingDeletes().catch(err=>{setSyncStatus('카드 기록 삭제 재시도 대기',false);console.error(err);});
  });
  document.querySelectorAll('.edit-card-record').forEach(b=>b.onclick=()=>renderCardRecordEdit(b.dataset.id));
}

function renderCardRecordEdit(recordId){
  const x=state.cardRecords.find(r=>r.id===recordId);
  if(!x){renderCards();return;}
  const owner=x.owner||((x.card==='아내카드')?'아내':'남편');
  const cards=owner==='남편'?(state.settings.husbandCards||[]):(state.settings.wifeCards||[]);
  app.innerHTML=`<div class="card card-record-edit">
    <div class="card-head"><div><h2>카드 기록 수정</h2><p>카드 청구 확인용 기록을 수정합니다.</p></div></div>
    <form id="cardRecordEditForm" novalidate>
      <div class="field"><label>사용자</label><div class="segmented owner-tabs" id="editOwnerTabs"><button type="button" class="${owner==='남편'?'active':''}" data-owner="남편">남편카드</button><button type="button" class="${owner==='아내'?'active':''}" data-owner="아내">아내카드</button></div></div>
      <input type="hidden" name="owner" id="editCardOwner" value="${esc(owner)}">
      <input type="hidden" name="cardType" id="editCardType" value="${esc(x.cardType||cards[0]||'')}">
      <div class="field section-gap-sm"><label>카드 종류</label><div class="card-type-tabs" id="editCardTypeTabs"></div></div>
      <div class="form-grid section-gap">
        <div class="field"><label>금액</label><input name="amount" type="number" min="0" inputmode="numeric" value="${Number(x.amount)||0}"></div>
        <div class="field"><label>기록명</label><input name="memo" value="${esc(x.memo||'')}"></div>
      </div>
      <div class="button-row"><button type="button" class="btn" id="cancelCardRecordEdit">취소</button><button class="btn primary" type="submit">수정 저장</button></div>
    </form>
  </div>`;

  const ownerInput=document.getElementById('editCardOwner');
  const typeInput=document.getElementById('editCardType');
  const ownerTabs=document.getElementById('editOwnerTabs');
  const typeTabs=document.getElementById('editCardTypeTabs');
  function drawTypes(){
    const list=ownerInput.value==='남편'?(state.settings.husbandCards||[]):(state.settings.wifeCards||[]);
    if(!list.includes(typeInput.value)) typeInput.value=list[0]||'';
    typeTabs.innerHTML=list.map(c=>`<button type="button" class="card-type-tab ${c===typeInput.value?'active':''}" data-type="${esc(c)}">${esc(c)}</button>`).join('');
    typeTabs.querySelectorAll('button').forEach(b=>b.onclick=()=>{typeInput.value=b.dataset.type;typeTabs.querySelectorAll('button').forEach(q=>q.classList.toggle('active',q===b));});
  }
  ownerTabs.querySelectorAll('button').forEach(b=>b.onclick=()=>{
    ownerInput.value=b.dataset.owner;
    ownerTabs.querySelectorAll('button').forEach(q=>q.classList.toggle('active',q===b));
    typeInput.value='';
    drawTypes();
  });
  drawTypes();
  document.getElementById('cancelCardRecordEdit').onclick=()=>renderCards();
  document.getElementById('cardRecordEditForm').onsubmit=e=>{
    e.preventDefault();
    const f=new FormData(e.target),newOwner=String(f.get('owner')||''),newType=String(f.get('cardType')||''),amount=parseAmount(f.get('amount')),memo=String(f.get('memo')||'').trim();
    if(!newOwner||!newType){toast('사용자와 카드 종류를 선택해 주세요.');return;}
    if(!Number.isFinite(amount)||amount<0){toast('올바른 카드 금액을 입력해 주세요.');return;}
    Object.assign(x,{owner:newOwner,cardType:newType,card:newOwner+'카드',amount,memo,updatedAt:new Date().toISOString()});
    formDirty=false;saveLocalOnly();toast('카드 기록을 수정했습니다.');renderCards();
    queuePendingUpserts('cardRecords',[x]);
    flushPendingUpserts().catch(err=>{setSyncStatus('카드 청구 기록 수정 재시도 대기',false);console.error(err);});
  };
}

function renderSettings(){
  app.innerHTML=`<div class="card tab-behavior-card">
    <div class="card-head"><div><h2>입력 탭 시작 방식</h2><p>등록 화면의 선택 탭이 페이지 진입 시 어떤 상태로 시작할지 정합니다.</p></div></div>
    <div class="setting-choice-grid" id="entryTabBehaviorSetting">
      <button type="button" class="setting-choice ${state.settings.entryTabBehavior!=='first'?'active':''}" data-value="remember">
        <strong>마지막 사용 탭 기억</strong>
        <span>처음에는 첫 번째 탭 · 이후에는 마지막으로 사용한 탭</span>
      </button>
      <button type="button" class="setting-choice ${state.settings.entryTabBehavior==='first'?'active':''}" data-value="first">
        <strong>항상 첫 번째 탭</strong>
        <span>페이지에 들어올 때마다 언제나 첫 번째 탭부터 시작</span>
      </button>
    </div>
  </div>
  <div class="grid cols-2 section-gap">
    <div class="card"><div class="card-head"><div><h2>이벤트 세부분류</h2><p>경조사·병원·교회 등 필요에 따라 추가할 수 있습니다.</p></div></div><div class="list-editor" id="eventList">${state.settings.eventCategories.map((x,i)=>`<div class="edit-row reorder-row"><input value="${esc(x)}" data-i="${i}"><div class="reorder-actions"><button class="icon-btn ghost move-event" data-i="${i}" data-dir="-1" title="위로">↑</button><button class="icon-btn ghost move-event" data-i="${i}" data-dir="1" title="아래로">↓</button><button class="icon-btn ghost event-del" data-i="${i}">×</button></div></div>`).join('')}</div><div class="divider"></div><div class="inline-add"><input id="newEvent" placeholder="새 이벤트 분류"><button class="btn primary" id="addEvent">추가</button></div></div>
    <div class="card brand-settings-card"><div class="card-head"><div><h2>가계부 이름</h2><p>메뉴와 PIN 화면에 표시할 아이콘과 이름을 변경합니다.</p></div></div>
      <form id="brandSettingsForm" class="form-grid">
        <label><span>아이콘</span><input name="brandIcon" maxlength="3" value="${esc(state.settings.brandIcon||'₩')}"></label>
        <label><span>메인 이름</span><input name="brandTitle" value="${esc(state.settings.brandTitle||'우리집 가계부')}"></label>
        <label class="field full"><span>보조 이름</span><input name="brandSubtitle" value="${esc(state.settings.brandSubtitle||'Couple Budget')}"></label>
        <div class="form-action"><button class="btn primary" type="submit">이름 저장</button></div>
      </form></div>
    <div class="card"><div class="card-head"><div><h2>화면 스타일</h2><p>두 기기에서 각각 원하는 스타일을 선택할 수 있습니다.</p></div></div><div class="theme-choice"><button class="theme-option ${uiTheme==='current'?'active':''}" data-theme="current"><strong>Current</strong><span>현재의 차분한 금융앱 스타일</span></button><button class="theme-option ${uiTheme==='lovable'?'active':''}" data-theme="lovable"><strong>Lovable</strong><span>그라디언트와 친근한 SaaS 스타일</span></button></div></div>
  </div>
  <div class="grid cols-2 section-gap">
    <div class="card"><div class="card-head"><div><h2>월별 수입 대분류</h2><p>이름 변경은 과거 기록에도 반영됩니다. 삭제는 기존 기록을 지우지 않고 보관합니다.</p></div></div>
      <div class="list-editor">${incomeCategories().map((x,i)=>`<div class="edit-row reorder-row category-setting-row"><input value="${esc(x)}" data-budget-cat="income" data-index="${i}" data-original="${esc(x)}"><div class="reorder-actions"><button class="icon-btn ghost move-budget-cat" data-budget-cat="income" data-index="${i}" data-dir="-1">↑</button><button class="icon-btn ghost move-budget-cat" data-budget-cat="income" data-index="${i}" data-dir="1">↓</button><button class="icon-btn ghost archive-budget-cat" data-budget-cat="income" data-index="${i}" title="분류 보관">×</button></div></div>`).join('')}</div>
      <div class="inline-add section-gap-sm"><input id="newIncomeCategory" placeholder="새 수입 대분류"><button class="btn small add-budget-cat" data-budget-cat="income" type="button">추가</button></div>
    </div>
    <div class="card"><div class="card-head"><div><h2>기본지출 대분류</h2><p>신규 등록에 사용할 분류입니다. 보관한 분류의 과거 기록은 유지됩니다.</p></div></div>
      <div class="list-editor">${fixedCategories().map((x,i)=>`<div class="edit-row reorder-row category-setting-row"><input value="${esc(x)}" data-budget-cat="fixed" data-index="${i}" data-original="${esc(x)}"><div class="reorder-actions"><button class="icon-btn ghost move-budget-cat" data-budget-cat="fixed" data-index="${i}" data-dir="-1">↑</button><button class="icon-btn ghost move-budget-cat" data-budget-cat="fixed" data-index="${i}" data-dir="1">↓</button><button class="icon-btn ghost archive-budget-cat" data-budget-cat="fixed" data-index="${i}" title="분류 보관">×</button></div></div>`).join('')}</div>
      <div class="inline-add section-gap-sm"><input id="newFixedCategory" placeholder="새 기본지출 대분류"><button class="btn small add-budget-cat" data-budget-cat="fixed" type="button">추가</button></div>
    </div>
  </div>
  <div class="card section-gap">
    <div class="card-head"><div><h2>카드 종류 설정</h2><p>카드 사용 기록 메뉴에서 선택할 세부 카드 종류입니다.</p></div></div>
    <div class="grid cols-2 card-settings-grid">
      <div>
        <div class="settings-subtitle">남편카드</div>
        <div class="list-editor" id="husbandCardList">${(state.settings.husbandCards||[]).map((x,i)=>`<div class="edit-row card-setting-row reorder-row"><input value="${esc(x)}" data-card-owner="husband" data-index="${i}"><div class="reorder-actions"><button class="icon-btn ghost move-card-type" data-card-owner="husband" data-index="${i}" data-dir="-1">↑</button><button class="icon-btn ghost move-card-type" data-card-owner="husband" data-index="${i}" data-dir="1">↓</button><button class="icon-btn ghost delete-card-type" data-card-owner="husband" data-index="${i}">×</button></div></div>`).join('')}</div>
        <div class="inline-add section-gap-sm"><input id="newHusbandCard" placeholder="예: 삼성"><button class="btn small" id="addHusbandCard" type="button">추가</button></div>
      </div>
      <div>
        <div class="settings-subtitle">아내카드</div>
        <div class="list-editor" id="wifeCardList">${(state.settings.wifeCards||[]).map((x,i)=>`<div class="edit-row card-setting-row reorder-row"><input value="${esc(x)}" data-card-owner="wife" data-index="${i}"><div class="reorder-actions"><button class="icon-btn ghost move-card-type" data-card-owner="wife" data-index="${i}" data-dir="-1">↑</button><button class="icon-btn ghost move-card-type" data-card-owner="wife" data-index="${i}" data-dir="1">↓</button><button class="icon-btn ghost delete-card-type" data-card-owner="wife" data-index="${i}">×</button></div></div>`).join('')}</div>
        <div class="inline-add section-gap-sm"><input id="newWifeCard" placeholder="예: 롯데"><button class="btn small" id="addWifeCard" type="button">추가</button></div>
      </div>
    </div>
  </div>
  <div class="grid cols-2 section-gap">
    <div class="card"><div class="card-head"><div><h2>가용금액 수정 보호</h2><p>가용금액 수정 시 현재 가계부 접속 PIN을 다시 확인합니다.</p></div></div><div class="notice">별도 관리 PIN은 사용하지 않습니다. 가계부 접속 PIN이 일치해야만 가용금액을 변경할 수 있습니다.</div></div>
    <div class="card"><div class="card-head"><div><h2>접속 PIN 변경</h2><p>변경하면 모든 기기에서 새 PIN을 사용합니다.</p></div></div><form id="pinChangeForm" class="form-grid"><label><span>현재 PIN</span><input id="currentPin" type="password" inputmode="numeric" maxlength="12" required></label><label><span>새 PIN</span><input id="newPin" type="password" inputmode="numeric" maxlength="12" placeholder="숫자 4~12자리" required></label><label><span>새 PIN 확인</span><input id="newPin2" type="password" inputmode="numeric" maxlength="12" required></label><div class="form-action"><button class="btn primary" type="submit">PIN 변경</button></div></form><div id="pinChangeMsg" class="helper-text"></div></div>
  </div>`;
  document.querySelectorAll('#entryTabBehaviorSetting .setting-choice').forEach(btn=>btn.onclick=()=>{
    state.settings.entryTabBehavior=btn.dataset.value==='first'?'first':'remember';
    saveSettingsState();
    renderSettings();
    toast(state.settings.entryTabBehavior==='first'?'항상 첫 번째 탭으로 설정했습니다.':'마지막 사용 탭을 기억하도록 설정했습니다.');
  });

  document.querySelectorAll('#eventList input').forEach(inp=>inp.onchange=()=>{state.settings.eventCategories[Number(inp.dataset.i)]=inp.value.trim();saveState()});
  document.querySelectorAll('.move-event').forEach(b=>b.onclick=()=>{
    const arr=state.settings.eventCategories,i=Number(b.dataset.i),j=i+Number(b.dataset.dir);
    if(j<0||j>=arr.length)return;
    [arr[i],arr[j]]=[arr[j],arr[i]];
    formDirty=false;saveSettingsState();renderSettings();
  });
  document.querySelectorAll('.event-del').forEach(b=>b.onclick=()=>{state.settings.eventCategories.splice(Number(b.dataset.i),1);saveSettingsState();renderSettings()});
  document.getElementById('addEvent').onclick=()=>{
    const input=document.getElementById('newEvent'),v=input.value.trim();
    if(!v){toast('이벤트 항목명을 입력해 주세요.');input.focus();return;}
    if(state.settings.eventCategories.includes(v)){toast('이미 있는 이벤트 항목입니다.');input.select();return;}
    state.settings.eventCategories.push(v);saveSettingsState();renderSettings();
  };
  function budgetCategoryArray(kind){return kind==='income'?state.settings.incomeCategories:state.settings.fixedCategories;}
  function budgetGroupedState(kind){return kind==='income'?state.incomes:state.fixedExpenses;}
  document.querySelectorAll('[data-budget-cat][data-original]').forEach(inp=>inp.onchange=()=>{
    const kind=inp.dataset.budgetCat,arr=budgetCategoryArray(kind),idx=Number(inp.dataset.index),old=inp.dataset.original,v=inp.value.trim();
    if(!v){toast('분류명을 비워둘 수 없습니다.');inp.value=old;return;}
    if(arr.some((x,i)=>x===v&&i!==idx)){toast('이미 있는 분류명입니다.');inp.value=old;return;}
    arr[idx]=v;
    const grouped=budgetGroupedState(kind);
    Object.values(grouped||{}).forEach(rows=>(rows||[]).forEach(r=>{if(r.category===old){r.category=v;r.updatedAt=new Date().toISOString();}}));
    formDirty=false;saveSettingsState(true);toast('분류명과 기존 기록을 함께 변경했습니다.');renderSettings();
  });
  document.querySelectorAll('.move-budget-cat').forEach(b=>b.onclick=()=>{
    const arr=budgetCategoryArray(b.dataset.budgetCat),i=Number(b.dataset.index),j=i+Number(b.dataset.dir);
    if(j<0||j>=arr.length)return;
    [arr[i],arr[j]]=[arr[j],arr[i]];formDirty=false;saveSettingsState();renderSettings();
  });
  document.querySelectorAll('.archive-budget-cat').forEach(b=>b.onclick=()=>{
    const kind=b.dataset.budgetCat,arr=budgetCategoryArray(kind),i=Number(b.dataset.index),name=arr[i];
    if(arr.length<=1){toast('대분류는 최소 1개가 필요합니다.');return;}
    const grouped=budgetGroupedState(kind);
    const used=Object.values(grouped||{}).flat().filter(r=>r.category===name).length;
    const msg=used?`"${name}" 분류를 신규 등록 목록에서 없앨까요?\n기존 ${used}건의 기록은 삭제되지 않고 "${name}" 분류로 그대로 보관됩니다.`:`"${name}" 분류를 삭제할까요?`;
    if(!confirm(msg))return;
    arr.splice(i,1);formDirty=false;saveSettingsState();renderSettings();
  });
  document.querySelectorAll('.add-budget-cat').forEach(b=>b.onclick=()=>{
    const kind=b.dataset.budgetCat,input=document.getElementById(kind==='income'?'newIncomeCategory':'newFixedCategory'),v=input.value.trim(),arr=budgetCategoryArray(kind);
    if(!v){toast('새 분류명을 입력해 주세요.');input.focus();return;}
    if(arr.includes(v)){toast('이미 있는 분류입니다.');return;}
    arr.push(v);formDirty=false;saveSettingsState();renderSettings();
  });
  function cardSettingsArray(owner){return owner==='husband'?state.settings.husbandCards:state.settings.wifeCards;}
  document.querySelectorAll('[data-card-owner][data-index]').forEach(el=>{
    if(el.classList.contains('delete-card-type')) return;
    el.onchange=()=>{
      const arr=cardSettingsArray(el.dataset.cardOwner),idx=Number(el.dataset.index),v=el.value.trim();
      if(!v){toast('카드 종류 이름을 비워둘 수 없습니다.');el.value=arr[idx]||'';return;}
      if(arr.some((x,i)=>x===v&&i!==idx)){toast('이미 등록된 카드 종류입니다.');el.value=arr[idx]||'';return;}
      arr[idx]=v;formDirty=false;saveSettingsState();toast('카드 종류를 수정했습니다.');
    };
  });
  document.querySelectorAll('.move-card-type').forEach(b=>b.onclick=()=>{
    const arr=cardSettingsArray(b.dataset.cardOwner),i=Number(b.dataset.index),j=i+Number(b.dataset.dir);
    if(j<0||j>=arr.length)return;
    [arr[i],arr[j]]=[arr[j],arr[i]];
    formDirty=false;saveSettingsState();renderSettings();
  });
  document.querySelectorAll('.delete-card-type').forEach(b=>b.onclick=()=>{
    const arr=cardSettingsArray(b.dataset.cardOwner),idx=Number(b.dataset.index);
    arr.splice(idx,1);formDirty=false;saveSettingsState();renderSettings();
  });
  function addCardType(owner,inputId){
    const input=document.getElementById(inputId),v=input.value.trim(),arr=cardSettingsArray(owner);
    if(!v){toast('카드 종류를 입력해 주세요.');input.focus();return;}
    if(arr.includes(v)){toast('이미 등록된 카드 종류입니다.');input.select();return;}
    arr.push(v);formDirty=false;saveSettingsState();renderSettings();
  }
  document.getElementById('addHusbandCard').onclick=()=>addCardType('husband','newHusbandCard');
  document.getElementById('addWifeCard').onclick=()=>addCardType('wife','newWifeCard');
  const brandForm=document.getElementById('brandSettingsForm');
  if(brandForm)brandForm.onsubmit=e=>{
    e.preventDefault();
    const f=new FormData(brandForm);
    state.settings.brandIcon=String(f.get('brandIcon')||'₩').trim()||'₩';
    state.settings.brandTitle=String(f.get('brandTitle')||'우리집 가계부').trim()||'우리집 가계부';
    state.settings.brandSubtitle=String(f.get('brandSubtitle')||'Couple Budget').trim();
    formDirty=false;saveSettingsState();applyBrand();toast('가계부 이름을 저장했습니다.');
  };
  document.querySelectorAll('.theme-option').forEach(b=>b.onclick=()=>{applyTheme(b.dataset.theme);renderSettings();toast('화면 스타일을 변경했습니다.');});
  const pinForm=document.getElementById('pinChangeForm'); if(pinForm) pinForm.onsubmit=async(e)=>{e.preventDefault();const current=document.getElementById('currentPin').value,np=document.getElementById('newPin').value,np2=document.getElementById('newPin2').value,msg=document.getElementById('pinChangeMsg'); if(np!==np2){msg.textContent='새 PIN 두 값이 서로 다릅니다.';msg.className='helper-text error';return;} try{msg.textContent='변경 중…';await changeSharedPin(current,np);msg.textContent='PIN이 변경되었습니다.';msg.className='helper-text success';pinForm.reset();}catch(err){msg.textContent=err.message||'PIN 변경 실패';msg.className='helper-text error';}};
}

render();
initPinGate().then(()=>{ if(!PIN_HASH || sessionStorage.getItem(PIN_SESSION_KEY)==='1') remoteLoad(); });
setInterval(()=>{ if(document.visibilityState==='visible' && !syncing && (!PIN_HASH || sessionStorage.getItem(PIN_SESSION_KEY)==='1')) remoteLoad(); },120000);
setInterval(()=>{ if(document.visibilityState==='visible') flushPendingMutations({quiet:true}).catch(()=>{}); },30000);
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible'){ flushPendingMutations({quiet:true}).catch(()=>{}); if(!syncing && (!PIN_HASH || sessionStorage.getItem(PIN_SESSION_KEY)==='1')) remoteLoad(); } });
