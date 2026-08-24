const STORAGE_KEY = 'coupleBudget_v1';
const today = new Date();
const pad = n => String(n).padStart(2,'0');
const currentMonth = `${today.getFullYear()}-${pad(today.getMonth()+1)}`;
const todayStr = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;

const defaultState = {
  settings: {
    variableCategories: ['고정','생활비','식비','이벤트'],
    eventCategories: ['경조사','병원','교회','여가','가구가전'],
    methods: ['현금','아내카드','남편카드']
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
const API_URL = (window.BUDGET_CONFIG && window.BUDGET_CONFIG.API_URL) || '';
let PIN_HASH = (window.BUDGET_CONFIG && window.BUDGET_CONFIG.PIN_HASH) || '';
const DEFAULT_PIN_HASH = PIN_HASH;
const PIN_SESSION_KEY = 'coupleBudget_pin_ok_v1';
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
    memo:String(f.get('memo')||'')
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
  document.body.classList.remove('locked');
}
function lockApp(){
  const gate=document.getElementById('pinGate');
  if(!gate) return;
  document.body.classList.add('locked');
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
    if(res && res.ok && res.pinHash) PIN_HASH=res.pinHash;
  }catch(err){ console.warn('PIN 설정 불러오기 실패, config.js 기본값 사용',err); }
  return PIN_HASH;
}
async function initPinGate(){
  await refreshPinHash();
  if(!PIN_HASH || sessionStorage.getItem(PIN_SESSION_KEY)==='1'){ unlockApp(); return; }
  lockApp();
  const form=document.getElementById('pinForm');
  const input=document.getElementById('pinInput');
  const error=document.getElementById('pinError');
  form.onsubmit=async(e)=>{
    e.preventDefault();
    const h=await sha256(input.value);
    if(h===PIN_HASH){ error.textContent=''; input.value=''; unlockApp(); remoteLoad(); }
    else { error.textContent='PIN이 올바르지 않습니다.'; input.select(); }
  };
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
function setSyncStatus(text, ok=true){ const el=document.getElementById('syncStatus'); if(el){ el.textContent=text; el.parentElement && el.parentElement.classList.toggle('sync-error',!ok); } }
function remoteLoad(){
  if(formDirty){ setSyncStatus('입력 중 · 자동 동기화 잠시 멈춤'); return Promise.resolve(false); }
  if(!apiConfigured()){ setSyncStatus('설정 필요: config.js에 Apps Script 주소 입력', false); return Promise.resolve(false); }
  return new Promise((resolve,reject)=>{
    const cb='budgetCb_'+Date.now()+'_'+Math.random().toString(36).slice(2);
    const sc=document.createElement('script');
    const timer=setTimeout(()=>{ cleanup(); reject(new Error('연결 시간 초과')); },12000);
    const cleanup=()=>{ clearTimeout(timer); try{delete window[cb]}catch{}; sc.remove(); };
    window[cb]=(res)=>{ cleanup(); if(res && res.ok && res.data){ state=normalizeStateModel({...structuredClone(defaultState),...res.data}); localStorage.setItem(STORAGE_KEY,JSON.stringify(state)); setSyncStatus('Google Sheets 동기화됨'); render(); resolve(true); } else { reject(new Error((res&&res.error)||'불러오기 실패')); } };
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
  fetch(API_URL,{method:'POST',mode:'no-cors',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action:'replaceState',payload:snapshot})})
    .then(()=>{setSyncStatus('Google Sheets 저장됨');})
    .catch(err=>{setSyncStatus('저장 오류 · 로컬에는 저장됨',false); console.error(err);})
    .finally(()=>{
      syncing=false;
      if(pendingSave) remoteSave();
    });
}


const pages = [
  ['add','＋','변동지출 등록','지출을 빠르게 기록하고 이번 달 잔액을 확인하세요.'],
  ['details','≡','변동지출 내역','등록된 지출을 날짜·분류·결제수단별로 확인하세요.'],
  ['summary','▦','연간 요약','한 해의 수입과 지출 흐름을 간단히 확인하세요.'],
  ['income','↗','월별 수입','월별 수입 항목을 등록하고 수정하세요.'],
  ['fixed','⌂','기본지출(현금고정지출)','월별 현금 고정지출 항목과 금액을 관리하세요.'],
  ['cards','▤','카드 사용 기록','카드별 청구·사용 금액을 별도로 기록하세요.'],
  ['settings','⚙','항목 설정','이벤트 세부분류 등 가계부 항목을 관리하세요.']
];

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const pageTitle = document.getElementById('pageTitle');
const pageSubtitle = document.getElementById('pageSubtitle');
const globalMonth = document.getElementById('globalMonth');
globalMonth.value = selectedMonth;

function normalizeStateModel(input){
  const s={...structuredClone(defaultState),...(input||{})};
  s.settings={...structuredClone(defaultState.settings),...(s.settings||{})};
  s.settings.variableCategories=['고정','생활비','식비','이벤트'];
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
function saveState(){ saveLocalOnly(); remoteSave(); }
function won(n){ return `${Math.round(Number(n)||0).toLocaleString('ko-KR')}원`; }
function monthOf(date){ return String(date||'').slice(0,7); }
function id(){ return `${Date.now()}_${Math.random().toString(36).slice(2,8)}`; }
function esc(s=''){ return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function toast(msg){ const el=document.getElementById('toast'); el.textContent=msg; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),1800); }

function renderNav(){
  nav.innerHTML = pages.map(([key,icon,label])=>`<button class="nav-item ${activePage===key?'active':''}" data-page="${key}"><span class="nav-icon">${icon}</span>${label}</button>`).join('');
  nav.querySelectorAll('button').forEach(b=>b.onclick=()=>{ formDirty=false; if(activePage==='add') clearExpenseDraft(); activePage=b.dataset.page; render(); closeMenu(); });
}
function bindGlobalFormDirtyGuard(){
  app.querySelectorAll('form input,form select,form textarea').forEach(el=>{
    el.addEventListener('focus',()=>{formDirty=true;});
    el.addEventListener('input',()=>{formDirty=true;});
    el.addEventListener('change',()=>{formDirty=true;});
  });
}
function render(){
  renderNav();
  const meta = pages.find(p=>p[0]===activePage);
  pageTitle.textContent = meta[2]; pageSubtitle.textContent = meta[3];
  globalMonth.style.display = activePage==='summary' ? 'none' : '';
  if(activePage==='add') renderAdd();
  if(activePage==='details') renderDetails();
  if(activePage==='summary') renderSummary();
  if(activePage==='income') renderIncome();
  if(activePage==='fixed') renderFixed();
  if(activePage==='cards') renderCards();
  if(activePage==='settings') renderSettings();
  bindGlobalFormDirtyGuard();
}

globalMonth.onchange=()=>{ selectedMonth=globalMonth.value || currentMonth; render(); };

document.getElementById('menuBtn').onclick=()=>{
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('backdrop').classList.add('show');
  document.body.classList.add('menu-open');
};
document.getElementById('backdrop').onclick=closeMenu;
function closeMenu(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('backdrop').classList.remove('show');
  document.body.classList.remove('menu-open');
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
  const totalVariable = monthExpenses.reduce((a,b)=>a+Number(b.amount||0),0);
  // 가용금액은 생활성 지출만 차감: 카드 고정지출(고정)과 이벤트는 제외
  const budgetVariable = monthExpenses
    .filter(x=>x.category!=='고정' && x.category!=='이벤트')
    .reduce((a,b)=>a+Number(b.amount||0),0);
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
  const draftMethod=draft.method||((state.settings.methods||[])[0]||'');
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
            <div class="field"><label>대분류</label><select name="categoryChoice" id="expenseCat">${options.map(o=>`<option value="${esc(o.value)}" ${o.value===draftChoice?'selected':''}>${esc(o.label)}</option>`).join('')}</select></div>
            <div class="field"><label>사용금액</label><input name="amount" type="number" min="1" inputmode="numeric" placeholder="예: 35000" value="${esc(draftAmount)}"></div>
            <div class="field"><label>사용날짜</label><input name="date" type="date" value="${esc(draftDate)}"></div>
            <div class="field"><label>지출방식</label><select name="method">${state.settings.methods.map(c=>`<option ${c===draftMethod?'selected':''}>${esc(c)}</option>`).join('')}</select></div>
            <div class="field full"><label>사용내역</label><input name="memo" placeholder="예: 마트 장보기, 아기 기저귀, 외식" value="${esc(draftMemo)}"></div>
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

  form.onsubmit=e=>{
    e.preventDefault();
    const f=new FormData(form);
    const amount=Number(f.get('amount'));
    const date=String(f.get('date')||'').trim();
    const method=String(f.get('method')||'').trim();
    const choice=String(f.get('categoryChoice')||defaultValue).trim();
    const parsed=parseExpenseCategory(choice);
    msg.textContent=''; msg.className='helper-text';
    if(!parsed.category){ msg.textContent='대분류를 선택해 주세요.'; msg.className='helper-text error'; cat.focus(); return; }
    if(!Number.isFinite(amount) || amount<=0){ msg.textContent='사용금액을 1원 이상 입력해 주세요.'; msg.className='helper-text error'; form.elements.amount.focus(); return; }
    if(!date){ msg.textContent='사용날짜를 선택해 주세요.'; msg.className='helper-text error'; form.elements.date.focus(); return; }
    if(!method){ msg.textContent='지출방식을 선택해 주세요.'; msg.className='helper-text error'; form.elements.method.focus(); return; }
    const createdNow=new Date().toISOString();
    state.variableExpenses.push({
      id:id(),category:parsed.category,detailCategory:parsed.detailCategory,eventCategory:parsed.eventCategory,
      amount,date,memo:String(f.get('memo')||'').trim(),method,
      createdAt:createdNow,updatedAt:createdNow
    });
    formDirty=false;
    clearExpenseDraft();
    saveState();
    toast('변동지출을 등록했습니다.');
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
    if(added){saveState();renderAdd();toast(`${added}건을 복사했습니다.`);} else alert('이미 같은 카드고정지출이 등록되어 있습니다.');
  };
  document.getElementById('goDetails').onclick=()=>{formDirty=false;clearExpenseDraft();activePage='details';render()};
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
    .reduce((a,b)=>a+Number(b.amount||0),0);
  return total/months.length;
}
function averageCompareMarkup(current, average){
  current=Number(current)||0; average=Number(average)||0;
  if(average<=0) return `<span class="avg-neutral">연평균 비교 데이터 없음</span>`;
  const pct=((current-average)/average)*100;
  if(Math.abs(pct)<1) return `<span class="avg-neutral">→ 연평균과 비슷</span>`;
  if(pct>0) return `<span class="avg-high">↑ 연평균보다 ${Math.abs(pct).toFixed(0)}% 높음</span>`;
  return `<span class="avg-low">↓ 연평균보다 ${Math.abs(pct).toFixed(0)}% 낮음</span>`;
}
function renderDetails(){
  let rows=state.variableExpenses.filter(x=>monthOf(x.date)===selectedMonth).sort((a,b)=>b.date.localeCompare(a.date));
  const total=rows.reduce((a,b)=>a+Number(b.amount),0); const year=selectedMonth.slice(0,4);
  const groupCard=(title,category,details)=>{
    const amount=rows.filter(x=>x.category===category).reduce((a,b)=>a+Number(b.amount||0),0);
    const avg=yearMonthlyAverage(year,category);
    const lines=details.map(d=>{
      const val=rows.filter(x=>x.category===category && (category==='이벤트'?x.eventCategory===d:x.detailCategory===d)).reduce((a,b)=>a+Number(b.amount||0),0);
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
    <div class="card section-gap"><div class="card-head"><div><h2>대분류별 지출</h2><p>${year}년 실제 기록이 있는 월 기준 월평균과 비교합니다.</p></div></div><div class="category-summary-grid">${cards}</div></div>
    <div class="card section-gap"><div class="card-head"><div><h2>${selectedMonth} 세부 내역</h2><p>등록한 내용을 수정하거나 삭제할 수 있습니다.</p></div></div><div class="table-wrap">${rows.length?`<table class="table"><thead><tr><th>날짜</th><th>분류</th><th>사용내역</th><th>지출방식</th><th class="amount">금액</th><th></th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.date)}</td><td><span class="pill ${x.category==='이벤트'?'event':''}">${esc(expenseDisplayName(x))}</span></td><td>${esc(x.memo||'-')}</td><td>${esc(x.method)}</td><td class="amount"><strong>${won(x.amount)}</strong></td><td><div class="row-actions"><button class="btn small edit-exp" data-id="${x.id}">수정</button><button class="btn small danger delete-exp" data-id="${x.id}">삭제</button></div></td></tr>`).join('')}</tbody></table>`:`<div class="empty">${selectedMonth}에 등록된 내역이 없습니다.</div>`}</div></div>`;
  document.querySelectorAll('.delete-exp').forEach(b=>b.onclick=()=>{if(confirm('이 지출 내역을 삭제할까요?')){state.variableExpenses=state.variableExpenses.filter(x=>x.id!==b.dataset.id);saveState();renderDetails()}});
  document.querySelectorAll('.edit-exp').forEach(b=>b.onclick=()=>renderExpenseEdit(b.dataset.id));
}

function renderExpenseEdit(expenseId){
  const x=state.variableExpenses.find(v=>v.id===expenseId);
  if(!x){ renderDetails(); return; }
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
        <div class="field full"><label>사용내역</label><input name="memo" value="${esc(x.memo||'')}"></div>
      </div>
      <div id="editExpenseMsg" class="helper-text"></div>
      <div class="button-row"><button type="button" class="btn" id="cancelExpenseEdit">취소</button><button type="submit" class="btn primary">수정 저장</button></div>
    </form>
  </div>`;
  document.getElementById('cancelExpenseEdit').onclick=()=>renderDetails();
  document.getElementById('editExpenseForm').onsubmit=e=>{
    e.preventDefault();
    const f=new FormData(e.target);
    const amount=Number(f.get('amount'));
    const date=String(f.get('date')||'').trim();
    const method=String(f.get('method')||'').trim();
    const parsed=parseExpenseCategory(String(f.get('categoryChoice')||''));
    const msg=document.getElementById('editExpenseMsg');
    if(!parsed.category || !Number.isFinite(amount) || amount<=0 || !date || !method){
      msg.textContent='대분류, 금액, 날짜, 지출방식을 확인해 주세요.';
      msg.className='helper-text error';
      return;
    }
    Object.assign(x,{category:parsed.category,detailCategory:parsed.detailCategory,eventCategory:parsed.eventCategory,amount,date,method,memo:String(f.get('memo')||'').trim()});
    formDirty=false;
    saveState();
    toast('지출 내역을 수정했습니다.');
    selectedMonth=monthOf(date)||selectedMonth;
    globalMonth.value=selectedMonth;
    renderDetails();
  };
}

function renderIncome(){
  const list=state.incomes[selectedMonth]||[]; const total=list.reduce((a,b)=>a+Number(b.amount),0);
  app.innerHTML=`<div class="grid cols-2"><div class="card"><div class="card-head"><div><h2>${selectedMonth} 수입 등록</h2><p>급여, 상여, 기타수입 등을 자유롭게 등록합니다.</p></div></div><form id="incomeForm" novalidate><div class="form-grid"><div class="field"><label>수입 항목</label><input name="name" placeholder="예: 남편 급여" required></div><div class="field"><label>금액</label><input name="amount" type="number" min="0" inputmode="numeric" required></div></div><div class="button-row"><button class="btn primary">추가</button></div></form></div><div class="card metric positive"><div class="metric-label">이번 달 총수입</div><div class="metric-value">${won(total)}</div><div class="metric-foot">등록된 ${list.length}개 항목 합계</div></div></div><div class="card section-gap"><div class="card-head"><h2>수입 항목</h2></div>${editorRows(list,'income')}</div>`;
  document.getElementById('incomeForm').onsubmit=e=>{
    e.preventDefault();
    const f=new FormData(e.target),name=String(f.get('name')||'').trim(),amount=Number(f.get('amount'));
    if(!name){toast('수입 항목을 입력해 주세요.');e.target.elements.name.focus();return;}
    if(!Number.isFinite(amount)||amount<0){toast('올바른 수입 금액을 입력해 주세요.');e.target.elements.amount.focus();return;}
    state.incomes[selectedMonth]=[...(state.incomes[selectedMonth]||[]),{id:id(),name,amount}];
    formDirty=false;
    saveState();renderIncome();
  }; bindEditor('income');
}
function renderFixed(){
  const list=state.fixedExpenses[selectedMonth]||[]; const total=list.reduce((a,b)=>a+Number(b.amount),0);
  app.innerHTML=`<div class="grid cols-2"><div class="card"><div class="card-head"><div><h2>${selectedMonth} 기본지출(현금고정지출) 추가</h2><p>매달 비슷한 항목은 전월에서 한 번에 가져올 수 있습니다.</p></div><button class="btn small" id="copyFixedBtn" type="button">전월 기본지출 복사</button></div><form id="fixedForm" novalidate><div class="form-grid"><div class="field"><label>지출 항목</label><input name="name" placeholder="예: 관리비" required></div><div class="field"><label>금액</label><input name="amount" type="number" min="0" inputmode="numeric" required></div></div><div class="button-row"><button class="btn primary">추가</button></div></form></div><div class="card metric negative"><div class="metric-label">이번 달 기본지출(현금고정지출)</div><div class="metric-value">${won(total)}</div><div class="metric-foot">등록된 ${list.length}개 항목 합계</div></div></div><div class="card section-gap"><div class="card-head"><h2>기본지출(현금고정지출) 항목</h2></div>${editorRows(list,'fixed')}</div>`;
  document.getElementById('fixedForm').onsubmit=e=>{
    e.preventDefault();
    const f=new FormData(e.target),name=String(f.get('name')||'').trim(),amount=Number(f.get('amount'));
    if(!name){toast('지출 항목을 입력해 주세요.');e.target.elements.name.focus();return;}
    if(!Number.isFinite(amount)||amount<0){toast('올바른 금액을 입력해 주세요.');e.target.elements.amount.focus();return;}
    state.fixedExpenses[selectedMonth]=[...(state.fixedExpenses[selectedMonth]||[]),{id:id(),name,amount}];
    formDirty=false;
    saveState();renderFixed();
  }; const cfb=document.getElementById('copyFixedBtn'); if(cfb) cfb.onclick=()=>{const prev=previousMonth(selectedMonth),src=state.fixedExpenses[prev]||[]; if(!src.length){alert(`${prev}에 기본지출이 없습니다.`);return;} if(!confirm(`${prev} 기본지출 ${src.length}개를 가져올까요?`))return; const cur=state.fixedExpenses[selectedMonth]||[]; const add=src.filter(x=>!cur.some(c=>c.name===x.name)).map(x=>({id:id(),name:x.name,amount:Number(x.amount)||0})); state.fixedExpenses[selectedMonth]=[...cur,...add]; saveState();renderFixed();toast(`${add.length}개 항목을 복사했습니다.`);}; bindEditor('fixed');
}
function editorRows(list,type){
  if(!list.length)return `<div class="empty">등록된 항목이 없습니다.</div>`;
  return `<div class="list-editor">${list.map(x=>`<div class="edit-row"><input value="${esc(x.name)}" data-id="${x.id}" data-k="name"><input type="number" value="${Number(x.amount)}" data-id="${x.id}" data-k="amount"><button class="icon-btn ghost delete-edit" data-id="${x.id}" title="삭제">×</button></div>`).join('')}</div>`;
}
function bindEditor(type){
  const arr=()=>type==='income'?state.incomes[selectedMonth]:state.fixedExpenses[selectedMonth];
  document.querySelectorAll('.edit-row input').forEach(inp=>inp.onchange=()=>{
    const x=arr().find(a=>a.id===inp.dataset.id); if(!x)return;
    if(inp.dataset.k==='amount'){
      const v=Number(inp.value);
      if(!Number.isFinite(v)||v<0){toast('올바른 금액을 입력해 주세요.');inp.value=Number(x.amount)||0;return;}
      x.amount=v;
    }else{
      const v=inp.value.trim();
      if(!v){toast('항목명을 비워둘 수 없습니다.');inp.value=x.name||'';return;}
      x.name=v;
    }
    saveState();toast('수정되었습니다.');
  });
  document.querySelectorAll('.delete-edit').forEach(b=>b.onclick=()=>{if(type==='income')state.incomes[selectedMonth]=arr().filter(x=>x.id!==b.dataset.id);else state.fixedExpenses[selectedMonth]=arr().filter(x=>x.id!==b.dataset.id);saveState();render()});
}

function renderCards(){
  const rows=state.cardRecords.filter(x=>x.month===selectedMonth); const total=rows.reduce((a,b)=>a+Number(b.amount),0);
  app.innerHTML=`<div class="grid cols-2"><div class="card"><div class="card-head"><div><h2>카드 사용 기록 추가</h2><p>실제 변동지출과 별개로 카드 청구·확인용으로 기록합니다.</p></div></div><form id="cardForm" novalidate><div class="form-grid"><div class="field"><label>카드</label><select name="card"><option>아내카드</option><option>남편카드</option></select></div><div class="field"><label>금액</label><input name="amount" type="number" min="0" required></div><div class="field"><label>기록명</label><input name="memo" placeholder="예: 8월 카드 사용액"></div></div><div class="button-row"><button class="btn primary">기록 추가</button></div></form></div><div class="card metric"><div class="metric-label">기록된 카드 금액</div><div class="metric-value">${won(total)}</div><div class="metric-foot">가계부 지출 합계와 자동 연동하지 않는 별도 기록</div></div></div><div class="card section-gap"><div class="card-head"><h2>${selectedMonth} 카드 기록</h2></div><div class="table-wrap">${rows.length?`<table class="table"><thead><tr><th>카드</th><th>기록명</th><th class="amount">금액</th><th></th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.card)}</td><td>${esc(x.memo||'-')}</td><td class="amount"><strong>${won(x.amount)}</strong></td><td><button class="btn small danger card-del" data-id="${x.id}">삭제</button></td></tr>`).join('')}</tbody></table>`:'<div class="empty">기록이 없습니다.</div>'}</div></div>`;
  document.getElementById('cardForm').onsubmit=e=>{
    e.preventDefault();
    const f=new FormData(e.target),card=String(f.get('card')||'').trim(),amount=Number(f.get('amount')),memo=String(f.get('memo')||'').trim();
    if(!card){toast('카드를 선택해 주세요.');return;}
    if(!Number.isFinite(amount)||amount<0){toast('올바른 카드 금액을 입력해 주세요.');e.target.elements.amount.focus();return;}
    state.cardRecords.push({id:id(),month:selectedMonth,card,amount,memo});
    formDirty=false;
    saveState();renderCards();
  }; document.querySelectorAll('.card-del').forEach(b=>b.onclick=()=>{state.cardRecords=state.cardRecords.filter(x=>x.id!==b.dataset.id);saveState();renderCards()});
}

function renderSummary(){
  const year=Number(selectedMonth.slice(0,4))||today.getFullYear();
  let ti=0,tf=0,tv=0;
  const ms=Array.from({length:12},(_,i)=>{const m=`${year}-${pad(i+1)}`,s=monthStats(m);ti+=s.income;tf+=s.fixed;tv+=s.variable;return {m,...s}});
  const totalSpend=tf+tv, net=ti-totalSpend;
  const cats=['고정','생활비','식비','이벤트'].map(c=>({c,v:state.variableExpenses.filter(x=>x.date.startsWith(String(year))&&x.category===c).reduce((a,b)=>a+Number(b.amount),0)})).sort((a,b)=>b.v-a.v);
  const maxCat=Math.max(...cats.map(x=>x.v),1);
  app.innerHTML=`<div class="card"><div class="card-head"><div><h2>${year}년 가계 요약</h2><p>월별 수입·기본지출·변동지출을 합산합니다.</p></div><select id="yearSelect" class="btn">${[year-2,year-1,year,year+1].map(y=>`<option ${y===year?'selected':''}>${y}</option>`).join('')}</select></div><div class="grid cols-4"><div class="metric"><div class="metric-label">연간 수입</div><div class="metric-value">${won(ti)}</div></div><div class="metric"><div class="metric-label">기본지출</div><div class="metric-value">${won(tf)}</div></div><div class="metric"><div class="metric-label">변동지출</div><div class="metric-value">${won(tv)}</div></div><div class="metric ${net>=0?'positive':'negative'}"><div class="metric-label">연간 잔액</div><div class="metric-value">${won(net)}</div></div></div></div>
  <div class="grid cols-2 section-gap"><div class="card"><div class="card-head"><h2>월별 흐름</h2></div><div class="year-grid">${ms.map((s,i)=>`<div class="month-box"><strong>${i+1}월</strong><span>수입 ${Math.round(s.income/10000).toLocaleString()}만</span><span>지출 ${Math.round((s.fixed+s.variable)/10000).toLocaleString()}만</span><em>${won(s.income-s.fixed-s.variable)}</em></div>`).join('')}</div></div><div class="card"><div class="card-head"><h2>변동지출 분류</h2></div><div class="summary-list">${cats.map(x=>`<div class="summary-line"><span>${esc(categoryDisplayName(x.c))}</span><div class="bar"><i style="width:${(x.v/maxCat)*100}%"></i></div><strong>${won(x.v)}</strong></div>`).join('')}</div></div></div>`;
  document.getElementById('yearSelect').onchange=e=>{selectedMonth=`${e.target.value}-01`;globalMonth.value=selectedMonth;renderSummary()};
}

function renderSettings(){
  app.innerHTML=`<div class="grid cols-2">
    <div class="card"><div class="card-head"><div><h2>이벤트 세부분류</h2><p>경조사·병원·교회 등 필요에 따라 추가할 수 있습니다.</p></div></div><div class="list-editor" id="eventList">${state.settings.eventCategories.map((x,i)=>`<div class="edit-row"><input value="${esc(x)}" data-i="${i}"><span></span><button class="icon-btn ghost event-del" data-i="${i}">×</button></div>`).join('')}</div><div class="divider"></div><div class="inline-add"><input id="newEvent" placeholder="새 이벤트 분류"><button class="btn primary" id="addEvent">추가</button></div></div>
    <div class="card"><div class="card-head"><div><h2>화면 스타일</h2><p>두 기기에서 각각 원하는 스타일을 선택할 수 있습니다.</p></div></div><div class="theme-choice"><button class="theme-option ${uiTheme==='current'?'active':''}" data-theme="current"><strong>Current</strong><span>현재의 차분한 금융앱 스타일</span></button><button class="theme-option ${uiTheme==='lovable'?'active':''}" data-theme="lovable"><strong>Lovable</strong><span>그라디언트와 친근한 SaaS 스타일</span></button></div></div>
  </div>
  <div class="grid cols-2 section-gap">
    <div class="card"><div class="card-head"><div><h2>가용금액 수정 보호</h2><p>가용금액 수정 시 현재 가계부 접속 PIN을 다시 확인합니다.</p></div></div><div class="notice">별도 관리 PIN은 사용하지 않습니다. 가계부 접속 PIN이 일치해야만 가용금액을 변경할 수 있습니다.</div></div>
    <div class="card"><div class="card-head"><div><h2>접속 PIN 변경</h2><p>변경하면 모든 기기에서 새 PIN을 사용합니다.</p></div></div><form id="pinChangeForm" class="form-grid"><label><span>현재 PIN</span><input id="currentPin" type="password" inputmode="numeric" maxlength="12" required></label><label><span>새 PIN</span><input id="newPin" type="password" inputmode="numeric" maxlength="12" placeholder="숫자 4~12자리" required></label><label><span>새 PIN 확인</span><input id="newPin2" type="password" inputmode="numeric" maxlength="12" required></label><div class="form-action"><button class="btn primary" type="submit">PIN 변경</button></div></form><div id="pinChangeMsg" class="helper-text"></div></div>
  </div>`;
  document.querySelectorAll('#eventList input').forEach(inp=>inp.onchange=()=>{state.settings.eventCategories[Number(inp.dataset.i)]=inp.value.trim();saveState()});
  document.querySelectorAll('.event-del').forEach(b=>b.onclick=()=>{state.settings.eventCategories.splice(Number(b.dataset.i),1);saveState();renderSettings()});
  document.getElementById('addEvent').onclick=()=>{
    const input=document.getElementById('newEvent'),v=input.value.trim();
    if(!v){toast('이벤트 항목명을 입력해 주세요.');input.focus();return;}
    if(state.settings.eventCategories.includes(v)){toast('이미 있는 이벤트 항목입니다.');input.select();return;}
    state.settings.eventCategories.push(v);saveState();renderSettings();
  };
  document.querySelectorAll('.theme-option').forEach(b=>b.onclick=()=>{applyTheme(b.dataset.theme);renderSettings();toast('화면 스타일을 변경했습니다.');});
  const pinForm=document.getElementById('pinChangeForm'); if(pinForm) pinForm.onsubmit=async(e)=>{e.preventDefault();const current=document.getElementById('currentPin').value,np=document.getElementById('newPin').value,np2=document.getElementById('newPin2').value,msg=document.getElementById('pinChangeMsg'); if(np!==np2){msg.textContent='새 PIN 두 값이 서로 다릅니다.';msg.className='helper-text error';return;} try{msg.textContent='변경 중…';await changeSharedPin(current,np);msg.textContent='PIN이 변경되었습니다.';msg.className='helper-text success';pinForm.reset();}catch(err){msg.textContent=err.message||'PIN 변경 실패';msg.className='helper-text error';}};
}

render();
initPinGate().then(()=>{ if(!PIN_HASH || sessionStorage.getItem(PIN_SESSION_KEY)==='1') remoteLoad(); });
setInterval(()=>{ if(document.visibilityState==='visible' && !syncing && (!PIN_HASH || sessionStorage.getItem(PIN_SESSION_KEY)==='1')) remoteLoad(); },30000);
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible' && !syncing && (!PIN_HASH || sessionStorage.getItem(PIN_SESSION_KEY)==='1')) remoteLoad(); });
