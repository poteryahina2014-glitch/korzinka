(function(){
const EMOJIS=["🛒","🥛","🍞","🧀","🥚","🍗","🥩","🐟","🍎","🍌","🥕","🥔","🍅","🧅","🍝","🍚","☕","🍵","🍫","🍪","🧃","🍷","🧈","🫒","🧂","🍯","🐱","🐶","🦴","🧻","🧼","🧽","🧴","🪥","🧹","🧺","🔋","💊","🍼","📦"];
const $=s=>document.querySelector(s);
const main=$("#main");
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ls={get(k,d){try{const v=localStorage.getItem("korzinka:"+k);return v==null?d:JSON.parse(v)}catch(e){return d}},set(k,v){try{localStorage.setItem("korzinka:"+k,JSON.stringify(v))}catch(e){}}};

const sb=supabase.createClient(CONFIG.url,CONFIG.key);
const COLS=["groups","items","stores"];
const TBL={groups:"k_groups",stores:"k_stores",items:"k_items"};
// columns each table accepts; the app keeps camelCase names, the base uses snake_case
const FIELDS={
  groups:["name","emoji","order"],
  stores:["name","emoji","url","searchUrl","order"],
  items:["name","note","groupId","storeId","emoji","image","price","need","inCart","oneOff","history","norm","checkEvery","stock","checkedAt","qty"],
};
// qty = how many units to buy; the column comes from 002_qty.sql — until it is run, the app just doesn't send it
let noQty=false;
const MAP={groupId:"group_id",storeId:"store_id",inCart:"in_cart",oneOff:"one_off",checkEvery:"check_every",checkedAt:"checked_at",searchUrl:"search_url",order:"ord"};
const UNMAP=Object.fromEntries(Object.entries(MAP).map(([a,b])=>[b,a]));
function fromRow(r){
  const o={};
  for(const [k,v] of Object.entries(r)){
    if(k==="id"||k==="user_id"||k==="created_at")continue;
    const kk=UNMAP[k]||k;
    o[kk]=kk==="checkedAt"?(v?Date.parse(v):null):kk==="price"?+v:(kk==="groupId"||kk==="storeId")?(v||""):v;
  }
  return o;
}
function toRow(col,o){
  const r={};
  for(const k of FIELDS[col]){
    if(!(k in o)||(k==="qty"&&noQty))continue;const v=o[k];
    if(k==="checkedAt")r.checked_at=v?new Date(v).toISOString():null;
    else if(k==="groupId"||k==="storeId")r[MAP[k]]=v||null;
    else r[MAP[k]||k]=v;
  }
  return r;
}

let S={groups:{},items:{},stores:{}};
const mode="remote";
let user=null;
let loaded={groups:false,items:false,stores:false};
// photos are stored right in the item row as a small jpeg
const assets={upload:async blob=>({id:await new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.onerror=rej;fr.readAsDataURL(blob)})}),delete:async()=>{}};
const imgSrc=v=>String(v||"").startsWith("data:")?v:"";
let storeFilter=ls.get("storeFilter","all");
let groupBy=ls.get("groupBy","cat");
const DAY=864e5;
let tab=["buy","cat","stock"].includes(ls.get("tab","buy"))?ls.get("tab","buy"):"buy", view=ls.get("view","list"), query="";
let collapsed=new Set(ls.get("collapsed",[]));
let quickGroup=ls.get("quickGroup","");

/* ---------- storage: Supabase, the screen updates first, the base after ---------- */
const queues={};
function enqueue(path,fn){const p=(queues[path]||Promise.resolve()).then(fn,fn);queues[path]=p.catch(()=>{});return p}
function fail(e){console.error(e);toast("Не удалось сохранить"+(e&&e.message?": "+e.message:" — проверьте интернет"));load()}
const newId=()=>crypto.randomUUID();
const done=r=>{if(r.error)throw r.error};

function put(col,id,data){
  S[col][id]=data;render();
  return enqueue(col+"/"+id,()=>sb.from(TBL[col]).upsert({id,...toRow(col,data)}).then(done)).catch(fail);
}
function patch(col,id,p){
  const cur=S[col][id];if(!cur)return Promise.resolve();
  S[col][id]=Object.assign({},cur,p);render();
  return enqueue(col+"/"+id,()=>sb.from(TBL[col]).update(toRow(col,p)).eq("id",id).then(done)).catch(fail);
}
function del(col,id){
  delete S[col][id];render();
  return enqueue(col+"/"+id,()=>sb.from(TBL[col]).delete().eq("id",id).then(done)).catch(fail);
}

async function load(){
  const rs=await Promise.all(COLS.map(c=>sb.from(TBL[c]).select("*")));
  const bad=rs.find(r=>r.error);
  if(bad){console.error(bad.error);main.innerHTML=`<div class="empty"><b>База ещё не готова</b>Нужно один раз запустить файл 001_korzinka.sql в Supabase → SQL Editor.</div>`;return}
  const ir=rs[COLS.indexOf("items")].data;noQty=!!ir.length&&!("qty" in ir[0]);
  COLS.forEach((c,i)=>{const o={};rs[i].data.forEach(r=>o[r.id]=fromRow(r));S[c]=o;loaded[c]=true});
  render();
}
let channel=null;
function listen(){
  if(channel)return;
  channel=sb.channel("korzinka");
  COLS.forEach(c=>channel.on("postgres_changes",{event:"*",schema:"public",table:TBL[c]},p=>{
    if(p.eventType==="DELETE")delete S[c][p.old.id];else S[c][p.new.id]=fromRow(p.new);
    render();
  }));
  channel.subscribe();
}
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&user)load()});

/* ---------- sign-in: the same account as in «Задачи» ---------- */
function renderLogin(msg="",err=false){
  $("#top").hidden=true;$("#share").hidden=true;
  main.innerHTML=`<form class="acard" id="login" style="margin-top:40px;align-items:stretch;text-align:left">
    <h2 style="text-align:center">🧺 Корзинка</h2>
    <p class="qty" style="margin:0;text-align:center">Вход тот же, что в приложении «Задачи».</p>
    <div class="fld"><label for="email">Почта</label><input id="email" type="email" autocomplete="email" required></div>
    <div class="fld"><label for="pass">Пароль</label><input id="pass" type="password" autocomplete="current-password" required></div>
    <button class="btn pri" type="submit" style="justify-content:center">Войти</button>
    ${msg?`<p class="qty" style="margin:0;${err?"color:var(--danger)":""}">${esc(msg)}</p>`:""}
  </form>`;
  $("#login").addEventListener("submit",async e=>{
    e.preventDefault();
    const {error}=await sb.auth.signInWithPassword({email:$("#email").value.trim(),password:$("#pass").value});
    if(error)renderLogin(/invalid login/i.test(error.message)?"Неверная почта или пароль":error.message,true);
  });
}
sb.auth.onAuthStateChange((ev,session)=>{
  const was=user&&user.id;user=session?session.user:null;
  if(!user){loaded={groups:false,items:false,stores:false};renderLogin();return}
  $("#top").hidden=false;
  if(was!==user.id)setTimeout(()=>{load();listen()},0);
});

/* ---------- settings: notifications, import, sign out ---------- */
const pushOk=()=>"serviceWorker" in navigator&&"PushManager" in window&&"Notification" in window;
const b64key=s=>Uint8Array.from(atob((s+"=".repeat((4-s.length%4)%4)).replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
async function pushSub(){if(!pushOk())return null;const reg=await navigator.serviceWorker.getRegistration();return reg?reg.pushManager.getSubscription():null}
async function settingsModal(){
  const sub=await pushSub(),on=!!sub&&Notification.permission==="granted";
  const {data:pref}=await sb.from("prefs").select("korz_time").maybeSingle();
  const t=String((pref&&pref.korz_time)||"10:00").slice(0,5);
  openModal(`<h2>Настройки</h2>
    <p class="qty" style="margin:0">Вы вошли как <b>${esc(user&&user.email)}</b> — это тот же аккаунт, что в «Задачах».</p>
    <div class="fld"><label>Уведомления на этом устройстве</label>
      <p class="qty" style="margin:0">Раз в день, если пора пересчитать что-то в Заначке.</p>
      ${!pushOk()?`<p class="qty" style="margin:0">Этот браузер не умеет уведомления. На телефоне откройте установленное приложение.</p>`
        :on?`<div class="abtns" style="justify-content:flex-start"><button class="btn" id="pTest">Прислать проверочное</button><button class="btn" id="pOff">Выключить</button></div>`
        :`<button class="btn pri" id="pOn" style="align-self:flex-start">Включить уведомления</button>`}
    </div>
    <div class="fld"><label for="kTime">Во сколько напоминать</label><input id="kTime" type="time" value="${t}" style="max-width:140px"></div>
    <div class="fld"><label>Перенос данных</label><button class="btn" id="imp" style="align-self:flex-start">Загрузить товары из файла</button>
      <div id="impAsk" hidden class="fld" style="gap:8px"><p class="qty" style="margin:0">Сейчас в Корзинке ${Object.keys(S.items).length} товаров и ${Object.keys(S.groups).length} групп. Что сделать с ними?</p>
        <div class="abtns" style="justify-content:flex-start"><button class="btn" id="impAdd">Оставить и добавить новые</button><button class="btn danger" id="impRep">Удалить всё и загрузить файл</button></div>
        <p class="qty" style="margin:0">При добавлении группы и магазины с теми же названиями не задвоятся, а товары, которые уже есть, пропустятся.</p></div></div>
    <div class="mact"><button class="btn danger left" id="out">Выйти из аккаунта</button><button class="btn pri" data-close>Готово</button></div>`,m=>{
    const q=s=>m.querySelector(s);
    if(q("#pOn"))q("#pOn").onclick=pushOn;
    if(q("#pOff"))q("#pOff").onclick=pushOff;
    if(q("#pTest"))q("#pTest").onclick=pushTest;
    q("#kTime").onchange=e=>e.target.value&&savePrefs({korz_time:e.target.value});
    // with something already in Корзинка, ask whether the file replaces it or adds to it
    const pick=m=>{importMode=m;$("#import-file").click()};
    q("#imp").onclick=()=>{
      if(!Object.keys(S.items).length&&!Object.keys(S.groups).length&&!Object.keys(S.stores).length)return pick("replace");
      q("#imp").hidden=true;q("#impAsk").hidden=false;
    };
    q("#impAdd").onclick=()=>pick("add");
    q("#impRep").onclick=()=>pick("replace");
    q("#out").onclick=()=>{closeModal();sb.auth.signOut()};
  });
}
async function savePrefs(row){
  const r=await sb.from("prefs").upsert({user_id:user.id,tz:Intl.DateTimeFormat().resolvedOptions().timeZone,...row});
  if(r.error)fail(r.error);
}
async function pushOn(){
  if(await Notification.requestPermission()!=="granted"){toast("Без разрешения уведомления не придут");return settingsModal()}
  const reg=await navigator.serviceWorker.ready;
  const sub=await reg.pushManager.getSubscription()||await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64key(CONFIG.vapid)});
  const j=sub.toJSON();
  const r=await sb.from("push_subs").upsert({endpoint:j.endpoint,p256dh:j.keys.p256dh,auth:j.keys.auth,app:"korzinka"},{onConflict:"endpoint"});
  if(r.error)return fail(r.error);
  await savePrefs({});toast("Уведомления включены");settingsModal();
}
async function pushOff(){
  const sub=await pushSub();
  if(sub){await sb.from("push_subs").delete().eq("endpoint",sub.endpoint);await sub.unsubscribe()}
  settingsModal();
}
async function pushTest(){
  const sub=await pushSub();if(!sub)return;
  try{const r=await fetch(CONFIG.url+"/functions/v1/notify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({test:sub.endpoint})});
    toast(r.ok?"Отправлено — придёт через пару секунд":"Сервер ответил ошибкой "+r.status)}
  catch(e){toast("Не получилось связаться с сервером")}
}

// file from the old Корзинка (claude.ai): {groups:{id:{…}}, stores:{…}, items:{…}}
let importMode="replace";
$("#import-file").addEventListener("change",async e=>{
  const f=e.target.files[0];e.target.value="";if(!f)return;
  let d;try{d=JSON.parse(await f.text())}catch(_){return toast("Это не файл Корзинки")}
  closeModal();toast("Загружаю…");
  const add=importMode==="add";
  const key=s=>String(s||"").trim().toLowerCase();
  // what is in the base right now — not what this page remembers
  const fromBase=async(t,cols)=>{const r=await sb.from(t).select(cols);done(r);return r.data};
  try{
    if(!add)for(const c of ["items","groups","stores"])done(await sb.from(TBL[c]).delete().not("id","is",null));
    // when adding: a group/store with the same name is reused, an item already present is skipped
    const byName=async t=>add?Object.fromEntries((await fromBase(t,"id,name")).map(x=>[key(x.name),x.id])):{};
    const have={groups:await byName(TBL.groups),stores:await byName(TBL.stores)};
    const haveItems=new Set(add?(await fromBase(TBL.items,"name")).map(x=>key(x.name)):[]);
    const ids={};
    const rows=col=>Object.entries(d[col]||{}).flatMap(([old,v])=>{
      if(col!=="items"&&have[col][key(v.name)]){ids[old]=have[col][key(v.name)];return []}
      if(col==="items"&&haveItems.has(key(v.name)))return [];
      const id=ids[old]=newId();
      // old files kept qty as text like «1 кг» — only a plain number means «how many to buy»
      if(col==="items"){const {qty,...rest}=v;v=/^\d+$/.test(String(qty??"").trim())?{...rest,qty:+qty}:rest}
      if(col==="items")v={...v,groupId:ids[v.groupId]||"",storeId:ids[v.storeId]||"",image:imgSrc(v.image),history:v.history||[]};
      return [{id,...toRow(col,v)}];
    });
    const g=rows("groups"),s=rows("stores"),it=rows("items");
    const skipped=Object.keys(d.items||{}).length-it.length;
    // defaultToNull:false — a field missing in some rows takes the column default instead of null
    const ins=(t,r)=>sb.from(t).insert(r,{defaultToNull:false});
    if(g.length)done(await ins(TBL.groups,g));
    if(s.length)done(await ins(TBL.stores,s));
    // an item never points to a group or store the base does not have
    const gOk=new Set((await fromBase(TBL.groups,"id")).map(x=>x.id)),sOk=new Set((await fromBase(TBL.stores,"id")).map(x=>x.id));
    it.forEach(r=>{if(r.group_id&&!gOk.has(r.group_id))r.group_id=null;if(r.store_id&&!sOk.has(r.store_id))r.store_id=null});
    for(let i=0;i<it.length;i+=200)done(await ins(TBL.items,it.slice(i,i+200)));
    toast(`Загружено: ${it.length} товаров`+(skipped?`, уже были: ${skipped}`:""));load();
  }catch(err){
    console.error(err);load();
    // keep the full reason on screen so it can be read or screenshotted
    const why=[err&&err.message,err&&err.details,err&&err.hint,err&&err.code].filter(Boolean).join("\n")||String(err);
    openModal(`<h2>Не получилось загрузить</h2><p class="qty" style="margin:0">Сделайте, пожалуйста, скриншот этого окна.</p><div class="fld"><textarea class="copy" readonly style="min-height:120px">${esc(why)}</textarea></div><div class="mact"><button class="btn pri" data-close>Закрыть</button></div>`);
  }
});

/* ---------- derived data ---------- */
function groupsSorted(){
  const g=Object.entries(S.groups).map(([id,v])=>({id,...v}));
  g.sort((a,b)=>(a.order??0)-(b.order??0)||String(a.name).localeCompare(b.name,"ru"));
  const hasOrphans=Object.values(S.items).some(it=>!S.groups[it.groupId]);
  if(hasOrphans)g.push({id:"",name:"Без группы",emoji:"📦",order:9999});
  return g;
}
function itemsOf(gid){
  return Object.entries(S.items).map(([id,v])=>({id,...v}))
    .filter(it=>(S.groups[it.groupId]?it.groupId:"")===gid)
    .sort((a,b)=>String(a.name).localeCompare(b.name,"ru"));
}
function storesSorted(){
  return Object.entries(S.stores).map(([id,v])=>({id,...v}))
    .sort((a,b)=>(a.order??0)-(b.order??0)||String(a.name).localeCompare(b.name,"ru"));
}
function inFilter(it){
  if(storeFilter==="all")return true;
  const sid=S.stores[it.storeId]?it.storeId:"";
  return storeFilter==="none"?!sid:sid===storeFilter;
}
function searchUrl(st,name){
  if(!st)return "";
  if(st.searchUrl&&st.searchUrl.includes("{q}"))return st.searchUrl.replace("{q}",encodeURIComponent(name));
  return st.url||"";
}
function safeUrl(u){return /^https?:\/\//i.test(u||"")?u:""}
function allItems(){
  return Object.entries(S.items).map(([id,v])=>({id,...v})).sort((a,b)=>String(a.name).localeCompare(b.name,"ru"));
}
// split items into sections according to the chosen grouping
function buckets(its){
  if(groupBy==="none")return [{key:"none",kind:"none",id:"",name:"",emoji:"",items:its}];
  if(groupBy==="store"){
    const list=storesSorted().map(s=>({key:"s:"+s.id,kind:"store",id:s.id,name:s.name,emoji:s.emoji,url:safeUrl(s.url)}));
    list.push({key:"s:",kind:"store",id:"",name:"Где угодно",emoji:"🛍️"});
    return list.map(b=>({...b,items:its.filter(i=>(S.stores[i.storeId]?i.storeId:"")===b.id)}));
  }
  return groupsSorted().map(g=>({...g,key:"g:"+g.id,kind:"cat",items:its.filter(i=>(S.groups[i.groupId]?i.groupId:"")===g.id)}));
}
// how many units to buy (no fixed unit: packs, kg, bottles — whatever fits the item)
const qtyOf=it=>Math.max(1,Math.round(+it.qty||1));
function qtyHtml(it){
  const q=qtyOf(it),id=esc(it.id);
  return `<div class="stepper qst"><button class="btn" data-act="qty" data-id="${id}" data-d="-1" aria-label="${q>1?"Меньше":"Убрать из списка"}">−</button><span class="qn" aria-label="Сколько купить">${q}</span><button class="btn" data-act="qty" data-id="${id}" data-d="1" aria-label="Больше">+</button></div>`;
}
function setQty(id,d){
  const it=S.items[id];if(!it)return;
  const q=(it.need?qtyOf(it):0)+d;
  if(q<1)patch("items",id,{need:false,inCart:false,qty:null});
  else patch("items",id,{need:true,qty:q});
}
function buyText(){
  const lines=[];
  buckets(allItems().filter(it=>it.need&&!it.inCart&&inFilter(it))).forEach(b=>{
    if(!b.items.length)return;
    if(b.kind!=="none"){if(lines.length)lines.push("");lines.push((b.emoji?b.emoji+" ":"")+b.name+":")}
    b.items.forEach(it=>lines.push("• "+it.name+(qtyOf(it)>1?" × "+qtyOf(it):"")+(it.note?" ("+it.note+")":"")));
  });
  const st=S.stores[storeFilter];
  const head=st?`Купить в ${st.name}:`:storeFilter==="none"?"Купить (где угодно):":"Купить:";
  return lines.length?head+"\n\n"+lines.join("\n"):"";
}

/* ---------- render ---------- */
function picHtml(it){
  const em=esc(it.emoji||"🛒");
  if(it.image)return `<div class="pic"><img src="${esc(imgSrc(it.image))}" alt="" loading="lazy" onerror="this.replaceWith(document.createTextNode('${em}'))"></div>`;
  return `<div class="pic" aria-hidden="true">${em}</div>`;
}
const editSvg=`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;

function render(){
  $("#tabBuy").setAttribute("aria-pressed",tab==="buy");
  $("#tabCat").setAttribute("aria-pressed",tab==="cat");
  $("#tabStock").setAttribute("aria-pressed",tab==="stock");
  document.querySelector(".viewsw").style.visibility=(tab==="stock"||audit)?"hidden":"";
  const od=overdue().length;$("#cntStock").hidden=!od;$("#cntStock").textContent=od;
  $("#vList").setAttribute("aria-pressed",view==="list");
  $("#vTiles").setAttribute("aria-pressed",view==="tiles");
  const needAll=Object.values(S.items).filter(i=>i.need);
  $("#cntBuy").textContent=needAll.length;
  if(!user||!COLS.every(c=>loaded[c]))return;
  if(storeFilter!=="all"&&storeFilter!=="none"&&!S.stores[storeFilter])storeFilter="all";
  const text=buyText();
  $("#share").hidden=tab!=="buy"||!!audit;
  $("#btnCopy").disabled=!text;
  $("#lnkTg").href="https://t.me/share/url?url="+encodeURIComponent(text||" ");
  $("#lnkWa").href="https://wa.me/?text="+encodeURIComponent(text);
  const left=needAll.filter(i=>!i.inCart&&inFilter(i)).length;
  $("#shareLbl").textContent=left?`Осталось купить: ${left}`:"Список пуст";
  // don't wipe a stock count the user is typing when a live update arrives
  if(document.activeElement&&document.activeElement.classList.contains("stock-in"))return;
  main.innerHTML=(audit?renderAudit():tab==="buy"?renderBuy():tab==="cat"?renderCat():renderStock());
}

/* ---------- audit: go through items one by one, «есть» / «нет» ---------- */
let audit=null; // {title, ids:[], ans:{id:true|false}}
function auditStartModal(){
  const all=allItems().filter(i=>!i.oneOff);
  const pick=new Set();
  const chip=(scope,label,n)=>n?`<button class="chip" data-pick="${esc(scope)}" aria-pressed="false">${label} <span class="cnt">${n}</span></button>`:"";
  const gs=groupsSorted().filter(g=>g.id).map(g=>chip("g:"+g.id,`${esc(g.emoji||"")} ${esc(g.name)}`,all.filter(i=>i.groupId===g.id).length)).join("");
  const ss=storesSorted().map(s=>chip("s:"+s.id,`${esc(s.emoji||"")} ${esc(s.name)}`,all.filter(i=>i.storeId===s.id).length)).join("");
  const chosen=()=>all.filter(i=>pick.has("g:"+i.groupId)||pick.has("s:"+i.storeId));
  const start=(its,title)=>{
    // walk in the same order as the catalog: by category, then name
    const ord={};groupsSorted().forEach((g,k)=>ord[g.id]=k);
    its=[...its].sort((a,c)=>(ord[a.groupId]??99)-(ord[c.groupId]??99)||String(a.name).localeCompare(c.name,"ru"));
    audit={title,ids:its.map(i=>i.id),ans:{}};closeModal();render();window.scrollTo(0,0);
  };
  openModal(`<h2>Что проверяем?</h2>
    <p class="qty" style="margin:0">Покажу список товаров — отмечайте «Есть» или «Нет» в любом порядке. Всё, чего нет, попадёт в список покупок.</p>
    <div class="fld"><button class="btn" data-all style="justify-content:center">Все товары · ${all.length}</button></div>
    <div class="fld"><label>Или выберите категории (можно несколько)</label><div class="chips" style="flex-wrap:wrap">${gs}</div></div>
    ${ss?`<div class="fld"><label>И/или магазины</label><div class="chips" style="flex-wrap:wrap">${ss}</div></div>`:""}
    <div class="mact"><button class="btn" data-close>Отмена</button><button class="btn pri" id="aGo" disabled>Выберите категории</button></div>`,m=>{
    const go=m.querySelector("#aGo");
    m.addEventListener("click",e=>{
      if(e.target.closest("[data-all]")){start(all,"Все товары");return}
      if(e.target.closest("#aGo")){const names=[...pick].map(k=>(k[0]==="g"?S.groups:S.stores)[k.slice(2)].name);start(chosen(),names.join(", "));return}
      const b=e.target.closest("[data-pick]");if(!b)return;
      const k=b.dataset.pick;pick.has(k)?pick.delete(k):pick.add(k);b.setAttribute("aria-pressed",pick.has(k));
      const n=chosen().length;go.disabled=!n;go.textContent=n?`Начать · ${n}`:"Выберите категории";
    });
  });
}
function renderAudit(){
  const ids=audit.ids.filter(id=>S.items[id]);audit.ids=ids;
  const done=ids.filter(id=>audit.ans[id]!==undefined).length,total=ids.length,left=total-done;
  const miss=ids.filter(id=>audit.ans[id]===false).length;
  const cur=ids.find(id=>audit.ans[id]===undefined);
  let h=`<div class="ahead"><span><b>Проверка: ${esc(audit.title)}</b> · отмечено ${done} из ${total}</span><button class="btn ghost" data-act="auditStop">Прервать</button></div>
    <div class="aprog"><div style="width:${total?Math.round(done/total*100):0}%"></div></div>
    <p class="qty" style="margin:0">Отмечайте в любом порядке. На компьютере клавиши 1 — есть, 2 — нет отмечают товар в рамке.</p>`;
  let last=null;
  h+=`<div class="list">`;
  ids.forEach(id=>{const it=S.items[id],a=audit.ans[id];
    const gid=S.groups[it.groupId]?it.groupId:"";
    if(gid!==last){last=gid;const g=S.groups[gid];h+=`<div class="row asec">${g?esc((g.emoji||"")+" "+g.name):"Без группы"}</div>`}
    h+=`<div class="row arow${a===true?" a-yes":a===false?" a-no":""}${id===cur?" cur":""}" data-aid="${esc(id)}">${picHtml(it)}<div class="txt"><span class="nm">${esc(it.name)}</span>${it.note?`<span class="note-t">${esc(it.note)}</span>`:""}</div>
      <div class="ayn"><button class="btn yes${a===true?" on":""}" data-act="auditAns" data-id="${esc(id)}" data-v="1" aria-pressed="${a===true}">Есть</button><button class="btn no${a===false?" on":""}" data-act="auditAns" data-id="${esc(id)}" data-v="0" aria-pressed="${a===false}">Нет</button></div></div>`;
  });
  h+=`</div>`;
  h+=`<div class="abar">${left?`<button class="btn" data-act="auditNext">Без ответа: ${left} ↓</button>`:`<span>${miss?`Не хватает: <b>${miss}</b>`:"Всё есть 🎉"}</span>`}<button class="btn pri" data-act="auditSave"${left?" disabled":""}>Сохранить${miss?" и открыть список":""}</button></div>`;
  return h;
}
function auditScrollToCur(){
  const r=document.querySelector(".arow.cur");if(r)r.scrollIntoView({block:"center",behavior:"smooth"});
}
function auditAnswer(id,v){
  if(!audit||!id)return;
  // pressing the same answer again clears it
  if(audit.ans[id]===v)delete audit.ans[id];else audit.ans[id]=v;
  render();
}
async function auditSave(){
  const ans=audit.ans;audit=null;tab="buy";ls.set("tab",tab);render();
  let n=0;
  for(const [id,has] of Object.entries(ans)){const it=S.items[id];if(!it)continue;
    if(!has&&!it.need){n++;await patch("items",id,{need:true,inCart:false,qty:null})}
    else if(has&&it.need)await patch("items",id,{need:false,inCart:false,qty:null});
  }
  toast(n?`Добавлено в список: ${n}`:"Список обновлён");
}
document.addEventListener("keydown",e=>{
  if(!audit||$("#modalRoot").firstChild||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;
  if(e.key!=="1"&&e.key!=="2")return;
  const cur=document.querySelector(".arow.cur");if(!cur)return;
  auditAnswer(cur.dataset.aid,e.key==="1");auditScrollToCur();
});

/* ---------- stock ("Заначка"): norm vs. counted amount ---------- */
const tracked=()=>allItems().filter(i=>+i.norm>0);
const isOverdue=i=>!i.checkedAt||Date.now()-i.checkedAt>(+i.checkEvery||14)*DAY;
const overdue=()=>tracked().filter(isOverdue);
function setStock(id,v){
  const it=S.items[id];if(!it)return;v=Math.max(0,Math.round(v));
  const low=v<+it.norm;
  patch("items",id,{stock:v,checkedAt:Date.now(),need:low,inCart:false,qty:low?+it.norm-v:null});
  toast(low?`Меньше нормы — добавила в список: ${+it.norm-v}`:`Записала: ${v}`);
}
function renderStock(){
  const its=tracked(),od=overdue();
  let h=`<div class="toolbar"><button class="btn pri" data-act="addItem" data-norm="1">+ Новый товар в заначку</button></div><p class="qty" style="margin:0">Укажите, сколько чего должно быть дома. Когда пересчитаете, впишите сколько есть сейчас: если меньше нормы, товар сам попадёт в список покупок.</p>`;
  if(od.length&&its.length)h+=`<div class="banner"><b>Пора пересчитать: ${od.length}</b>${od.map(i=>esc(i.name)).join(", ")}</div>`;
  if(its.length){
    h+=`<div class="list">`;
    its.forEach(it=>{
      const st=it.stock??null,low=st!=null&&st<+it.norm,late=isOverdue(it);
      const ago=it.checkedAt?Math.floor((Date.now()-it.checkedAt)/DAY):null;
      const when=ago==null?"ещё не считали":ago<=0?"проверено сегодня":ago===1?"проверено вчера":`проверено ${ago} дн. назад`;
      h+=`<div class="row srow2${low?" need":""}">${picHtml(it)}<div class="txt"><span class="nm">${esc(it.name)}</span><span class="meta"><span>норма ${+it.norm}</span><span class="${late?"late":""}">${when}</span>${low?`<span class="price">докупить ${+it.norm-st}</span>`:""}</span></div>
        <div class="stepper"><button class="btn" data-act="stockStep" data-id="${esc(it.id)}" data-d="-1" aria-label="Меньше">−</button><input class="stock-in" data-id="${esc(it.id)}" type="number" inputmode="numeric" min="0" value="${st??""}" placeholder="?" aria-label="Сколько есть"><button class="btn" data-act="stockStep" data-id="${esc(it.id)}" data-d="1" aria-label="Больше">+</button></div>
        <button class="edit" data-act="editItem" data-id="${esc(it.id)}" aria-label="Изменить">${editSvg}</button></div>`;
    });
    h+=`</div>`;
  }else h+=`<div class="empty"><b>Пока ничего не отслеживается</b>Выберите товар ниже и задайте норму, например «Корм для кошки сухой — 2 пачки».</div>`;
  const rest=allItems().filter(i=>!i.oneOff&&!(+i.norm>0));
  h+=`<form class="toolbar" id="stockAdd"><select id="saItem" aria-label="Товар">${rest.map(i=>`<option value="${esc(i.id)}">${esc(i.name)}</option>`).join("")}</select>
    <input id="saNorm" type="number" min="1" inputmode="numeric" placeholder="Норма, шт" aria-label="Норма" style="flex:0 1 120px">
    <input id="saEvery" type="number" min="1" inputmode="numeric" value="14" aria-label="Проверять раз в N дней" title="Проверять раз в N дней" style="flex:0 1 90px">
    <button class="btn pri" type="submit">Добавить в заначку</button></form>
    <p class="qty" style="margin:0">Последнее число — как часто напоминать пересчитать, в днях.</p>`;
  return h;
}

function storeChips(){
  const need=Object.values(S.items).filter(i=>i.need);
  const cnt=f=>need.filter(i=>f(S.stores[i.storeId]?i.storeId:"")).length;
  let h=`<div class="chips" role="group" aria-label="Магазин"><button class="chip" data-act="sf" data-s="all" aria-pressed="${storeFilter==="all"}">Все <span class="cnt">${need.length}</span></button>`;
  storesSorted().forEach(s=>{const n=cnt(x=>x===s.id);if(!n&&storeFilter!==s.id)return;
    h+=`<button class="chip" data-act="sf" data-s="${esc(s.id)}" aria-pressed="${storeFilter===s.id}">${esc(s.emoji||"")} ${esc(s.name)} <span class="cnt">${n}</span></button>`});
  const nn=cnt(x=>!x);if(nn&&Object.keys(S.stores).length)h+=`<button class="chip" data-act="sf" data-s="none" aria-pressed="${storeFilter==="none"}">Где угодно <span class="cnt">${nn}</span></button>`;
  return h+`</div>`;
}

function viewbar(){
  const o=[["cat","Категории"],["store","Магазины"],["none","Без групп"]];
  return `<div class="viewbar">Группировать:<div class="seg" role="group" aria-label="Группировка">${o.map(([v,t])=>`<button data-act="gb" data-v="${v}" aria-pressed="${groupBy===v}">${t}</button>`).join("")}</div></div>`;
}

function renderBuy(){
  let h=viewbar();
  const od=overdue();
  if(od.length)h+=`<div class="banner"><b>Пора пересчитать запасы</b>${od.map(i=>esc(i.name)).join(", ")}<button class="btn pri" data-act="gotoStock">Открыть Заначку</button></div>`;
  h+=`<button class="btn acta" data-act="auditStart">✓ Пройтись по дому: что есть, чего нет</button>`;
  const gs=groupsSorted();
  if(Object.keys(S.stores).length)h+=storeChips();
  const st=S.stores[storeFilter],site=st&&safeUrl(st.url);
  if(site)h+=`<div class="storebar"><span class="sum"></span>${site?`<a class="btn" href="${esc(site)}" target="_blank" rel="noopener">Открыть сайт ${esc(st.name)} ↗</a>`:""}</div>`;
  h+=`<form class="toolbar" id="quick" autocomplete="off">
    <input id="quickName" placeholder="Добавить разово, например «свечи для торта»" aria-label="Название товара">
    <select id="quickGroup" aria-label="Группа">${gs.filter(g=>g.id).map(g=>`<option value="${esc(g.id)}"${g.id===quickGroup?" selected":""}>${esc(g.emoji||"")} ${esc(g.name)}</option>`).join("")||'<option value="">Без группы</option>'}</select>
    <button class="btn pri" type="submit">Добавить</button></form>`;
  const inCart=Object.values(S.items).filter(i=>i.need&&i.inCart).length;
  if(inCart)h+=`<div class="cartbar"><span>Куплено: ${inCart}</span><button class="btn pri" data-act="finish">Убрать купленное из списка</button></div>`;
  let any=false;
  buckets(allItems().filter(i=>i.need&&inFilter(i))).forEach(b=>{
    const its=b.items.sort((a,c)=>(a.inCart?1:0)-(c.inCart?1:0));
    if(!its.length)return;any=true;
    h+=groupHtml(b,its,"buy");
  });
  if(!any){
    const empty=!Object.keys(S.items).length;
    h+=`<div class="empty"><b>${empty?"Справочник пока пуст":storeFilter!=="all"?"Здесь покупать нечего":"Всё есть, покупать нечего"}</b>${empty?"Откройте «Справочник» и добавьте группы и товары, которые вы обычно покупаете.":"Когда что-то закончится, отметьте это в «Справочнике» — товар сразу попадёт сюда."}</div>`;
  }
  return h;
}

function renderCat(){
  let h=viewbar()+`<div class="toolbar"><input id="q" type="search" placeholder="Найти товар" value="${esc(query)}" aria-label="Поиск"><button class="btn" data-act="addItem">+ Товар</button><button class="btn" data-act="addGroup">+ Группа</button><button class="btn" data-act="stores">🏬 Магазины</button><button class="btn" data-act="auditStart">✓ Проверка</button></div>`;
  if(!groupsSorted().length)return h+`<div class="empty"><b>Начните с группы</b>Например: «Продукты», «Бытовое», «Питомцы», «Заначка». Нажмите «+ Группа».</div>`;
  const q=query.trim().toLowerCase();
  let shown=0;
  buckets(allItems().filter(i=>!i.oneOff&&(!q||String(i.name).toLowerCase().includes(q)))).forEach(b=>{
    if(!b.items.length&&(q||b.kind!=="cat"))return;shown++;
    h+=groupHtml(b,b.items,"cat");
  });
  if(q&&!shown)h+=`<div class="empty"><b>Ничего не нашлось</b>Проверьте написание или добавьте новый товар кнопкой «+ Товар».</div>`;
  return h;
}

function metaHtml(it){
  const st=S.stores[it.storeId],u=safeUrl(searchUrl(st,it.name));
  const parts=[];
  if(st)parts.push(u?`<a class="slink" href="${esc(u)}" target="_blank" rel="noopener" title="Найти на сайте">${esc(st.emoji||"")} ${esc(st.name)} ↗</a>`:`<span>${esc(st.emoji||"")} ${esc(st.name)}</span>`);
  return (it.note?`<span class="note-t">${esc(it.note)}</span>`:"")+(parts.length?`<span class="meta">${parts.join("")}</span>`:"");
}
function groupHtml(b,its,ctx){
  const key=ctx+":"+b.key,closed=b.kind!=="none"&&collapsed.has(key);
  const needN=its.filter(i=>i.need).length;
  const count=ctx==="cat"?`${its.length}${needN?` · нужно ${needN}`:""}`:`${its.filter(i=>!i.inCart).length}`;
  let h=`<section class="group${closed?" closed":""}">`;
  if(b.kind!=="none")h+=`<div class="ghead">
    <button class="gtitle" data-act="fold" data-key="${esc(key)}" aria-expanded="${!closed}"><span class="chev">▼</span><span class="em">${esc(b.emoji||"")}</span>${esc(b.name)} <span class="gcount">${count}</span></button>
    ${b.kind==="store"&&b.url?`<a class="slink" href="${esc(b.url)}" target="_blank" rel="noopener">сайт ↗</a>`:""}
    ${ctx==="cat"&&b.kind==="cat"&&b.id?`<button class="btn ghost" data-act="addItem" data-g="${esc(b.id)}">+ Товар</button><button class="edit" data-act="editGroup" data-g="${esc(b.id)}" aria-label="Изменить группу">${editSvg}</button>`:""}
  </div>`;
  h+=`<div class="gbody">`;
  if(view==="list"){
    h+=`<div class="list">`;
    its.forEach(it=>{
      const meta=metaHtml(it);
      if(ctx==="buy"){
        h+=`<div class="row${it.inCart?" done":""}"><button class="check" data-act="cart" data-id="${esc(it.id)}" aria-label="Купила">✓</button>${picHtml(it)}<div class="txt"><button class="txt" data-act="cart" data-id="${esc(it.id)}"><span class="nm">${esc(it.name)}</span></button>${meta}</div>${qtyHtml(it)}<button class="edit" data-act="editItem" data-id="${esc(it.id)}" aria-label="Изменить">${editSvg}</button></div>`;
      }else{
        h+=`<div class="row${it.need?" need":""}">${picHtml(it)}<div class="txt"><button class="txt" data-act="need" data-id="${esc(it.id)}"><span class="nm">${esc(it.name)}</span></button>${meta}</div>${it.need?qtyHtml(it):""}<button class="tog" data-act="need" data-id="${esc(it.id)}" aria-pressed="${!!it.need}" aria-label="Закончилось"></button><button class="edit" data-act="editItem" data-id="${esc(it.id)}" aria-label="Изменить">${editSvg}</button></div>`;
      }
    });
    if(!its.length)h+=`<div class="row"><span class="qty">В группе пока нет товаров</span></div>`;
    h+=`</div>`;
  }else{
    h+=`<div class="tiles">`;
    its.forEach(it=>{
      const cls=ctx==="buy"?(it.inCart?" done":""):(it.need?" need":"");
      h+=`<div class="tile${cls}"><button class="hit" data-act="${ctx==="buy"?"cart":"need"}" data-id="${esc(it.id)}">${picHtml(it)}<span class="cap"><span class="nm">${esc(it.name)}</span></span></button><div class="cap" style="padding-top:0">${metaHtml(it)}${it.need?qtyHtml(it):""}</div>${ctx==="cat"&&it.need?'<span class="badge">Нужно</span>':""}<button class="edit" data-act="editItem" data-id="${esc(it.id)}" aria-label="Изменить">${editSvg}</button></div>`;
    });
    if(!its.length)h+=`<span class="qty">В группе пока нет товаров</span>`;
    h+=`</div>`;
  }
  return h+`</div></section>`;
}

/* ---------- events ---------- */
document.addEventListener("click",e=>{
  const t=e.target.closest("[data-tab],[data-view],[data-act]");if(!t)return;
  if(t.dataset.tab){tab=t.dataset.tab;ls.set("tab",tab);render();window.scrollTo(0,0);return}
  if(t.dataset.view){view=t.dataset.view;ls.set("view",view);render();return}
  const a=t.dataset.act,id=t.dataset.id;
  if(a==="need"){const it=S.items[id];patch("items",id,{need:!it.need,inCart:false,qty:null})}
  else if(a==="cart"){const it=S.items[id];patch("items",id,{inCart:!it.inCart})}
  else if(a==="fold"){const k=t.dataset.key;collapsed.has(k)?collapsed.delete(k):collapsed.add(k);ls.set("collapsed",[...collapsed]);render()}
  else if(a==="finish")finishShopping();
  else if(a==="gb"){groupBy=t.dataset.v;ls.set("groupBy",groupBy);render()}
  else if(a==="sf"){storeFilter=t.dataset.s;ls.set("storeFilter",storeFilter);render()}
  else if(a==="stores")storesModal();
  else if(a==="settings")settingsModal();
  else if(a==="auditStart")auditStartModal();
  else if(a==="auditAns")auditAnswer(id,t.dataset.v==="1");
  else if(a==="auditNext")auditScrollToCur();
  else if(a==="auditStop"){audit=null;render()}
  else if(a==="auditSave")auditSave();
  else if(a==="qty")setQty(id,+t.dataset.d);
  else if(a==="stockStep"){const it=S.items[id];setStock(id,(+it.stock||0)+(+t.dataset.d))}
  else if(a==="gotoStock"){tab="stock";ls.set("tab",tab);render();window.scrollTo(0,0)}
  else if(a==="addGroup")groupModal(null);
  else if(a==="editGroup")groupModal(t.dataset.g);
  else if(a==="addItem")itemModal(null,t.dataset.g,+t.dataset.norm||0);
  else if(a==="editItem")itemModal(id);
});
main.addEventListener("input",e=>{
  if(e.target.id==="q"){query=e.target.value;const pos=e.target.selectionStart;render();const q=$("#q");q.focus();try{q.setSelectionRange(pos,pos)}catch(_){}}
});
main.addEventListener("change",e=>{
  if(e.target.id==="quickGroup"){quickGroup=e.target.value;ls.set("quickGroup",quickGroup)}
  if(e.target.classList.contains("stock-in")&&e.target.value!==""){const v=+e.target.value;e.target.blur();setStock(e.target.dataset.id,v)}
});
main.addEventListener("submit",e=>{
  if(e.target.id==="stockAdd"){e.preventDefault();
    const id=$("#saItem").value,norm=Math.round(+$("#saNorm").value),every=Math.round(+$("#saEvery").value)||14;
    if(!id||!(norm>0)){toast("Укажите норму — сколько штук должно быть дома");return}
    patch("items",id,{norm,checkEvery:every});return}
  if(e.target.id!=="quick")return;e.preventDefault();
  const name=$("#quickName").value.trim();if(!name)return;
  const gid=$("#quickGroup").value;quickGroup=gid;ls.set("quickGroup",gid);
  const g=S.groups[gid];
  const sid=S.stores[storeFilter]?storeFilter:"";
  put("items",newId(),{name,groupId:gid,emoji:(g&&g.emoji)||"🛒",need:true,inCart:false,oneOff:true,storeId:sid});
  toast("Добавлено в список");
});

async function finishShopping(){
  const done=Object.entries(S.items).filter(([,i])=>i.need&&i.inCart);
  const now=Date.now();
  for(const [id,it] of done){
    if(it.oneOff){await del("items",id);continue}
    const history=[...(it.history||[]),now].slice(-200);
    await patch("items",id,{need:false,inCart:false,history,qty:null});
  }
  toast(`Куплено: ${done.length}`);
}

$("#btnCopy").addEventListener("click",()=>{
  const text=buyText();if(!text)return;
  const fallback=()=>openModal(`<h2>Скопируйте список</h2><div class="fld"><textarea class="copy" id="copyTa" readonly>${esc(text)}</textarea></div><div class="mact"><button class="btn pri" data-close>Готово</button></div>`,m=>{const ta=m.querySelector("#copyTa");ta.focus();ta.select()});
  try{navigator.clipboard.writeText(text).then(()=>toast("Список скопирован — вставьте в мессенджер"),fallback)}catch(e){fallback()}
});
// on the phone: the system «share» sheet with all messengers
if(navigator.share){$("#btnShare").hidden=false;$("#btnShare").addEventListener("click",()=>{const text=buyText();if(text)navigator.share({text}).catch(()=>{})})}

/* ---------- modals ---------- */
function openModal(html,init,panel){
  const root=$("#modalRoot");
  if(onClose){const f=onClose;onClose=null;f()}
  root.innerHTML=`<div class="ov${panel?" panel":""}"><div class="modal" role="dialog" aria-modal="${!panel}">${html}</div></div>`;
  const ov=root.firstChild,m=ov.firstChild;
  ov.addEventListener("click",e=>{if(e.target===ov||e.target.closest("[data-close]"))closeModal()});
  document.addEventListener("keydown",escClose);
  init&&init(m);return m;
}
const openPanel=(html,init)=>openModal(html,init,true);
function escClose(e){if(e.key==="Escape")closeModal()}
let onClose=null;
function closeModal(){$("#modalRoot").innerHTML="";document.body.classList.remove("panel-open");document.removeEventListener("keydown",escClose);if(onClose){const f=onClose;onClose=null;f()}}

function emojiPicker(cur){return `<div class="emojis">${EMOJIS.map(x=>`<button type="button" data-em="${x}" aria-pressed="${x===cur}">${x}</button>`).join("")}</div>`}
function wireEmoji(m,input){
  m.querySelector(".emojis").addEventListener("click",e=>{const b=e.target.closest("[data-em]");if(!b)return;input.value=b.dataset.em;input.dispatchEvent(new Event("input"));m.querySelectorAll(".emojis button").forEach(x=>x.setAttribute("aria-pressed",x===b))});
}

function groupModal(gid){
  const g=gid?S.groups[gid]:{name:"",emoji:"🛒"};
  const its=gid?itemsOf(gid):[];
  openPanel(`<h2>${gid?"Группа":"Новая группа"}</h2>
    <form id="gf" class="fld" style="gap:12px">
      <div class="fld"><label for="gName">Название</label><input id="gName" required value="${esc(g.name)}" placeholder="Например, Питомцы"></div>
      <div class="fld"><label for="gEm">Значок</label><input id="gEm" value="${esc(g.emoji||"")}" maxlength="8">${emojiPicker(g.emoji)}</div>
      ${gid?`<div class="fld"><label>Порядок</label><div style="display:flex;gap:8px"><button type="button" class="btn" id="gUp">↑ Выше</button><button type="button" class="btn" id="gDown">↓ Ниже</button></div></div>`:""}
      <div class="mact">${gid?`<button type="button" class="btn danger left" id="gDel">Удалить</button>`:""}<button type="button" class="btn" data-close>Отмена</button><button class="btn pri" type="submit">Сохранить</button></div>
    </form>`,m=>{
    wireEmoji(m,m.querySelector("#gEm"));
    if(!gid)m.querySelector("#gName").focus();
    m.querySelector("#gf").addEventListener("submit",e=>{
      e.preventDefault();
      const name=m.querySelector("#gName").value.trim();if(!name)return;
      const emoji=m.querySelector("#gEm").value.trim();
      if(gid)patch("groups",gid,{name,emoji});
      else{const max=Math.max(0,...Object.values(S.groups).map(x=>x.order||0));put("groups",newId(),{name,emoji,order:max+1})}
      closeModal();
    });
    if(gid){
      const move=async dir=>{
        const gs=groupsSorted().filter(x=>x.id);const i=gs.findIndex(x=>x.id===gid),j=i+dir;
        if(j<0||j>=gs.length)return;
        // renumber so swaps are stable even if orders were equal
        for(let k=0;k<gs.length;k++){const want=k===i?j:k===j?i:k;if((gs[k].order??-1)!==want)await patch("groups",gs[k].id,{order:want})}
        toast(dir<0?"Группа выше":"Группа ниже");
      };
      m.querySelector("#gUp").onclick=()=>move(-1);
      m.querySelector("#gDown").onclick=()=>move(1);
      const delB=m.querySelector("#gDel");let armed=false;
      delB.onclick=async()=>{
        if(!armed){armed=true;delB.textContent=its.length?`Удалить группу и ${its.length} тов.?`:"Точно удалить?";return}
        closeModal();
        for(const it of its)await del("items",it.id);
        await del("groups",gid);toast("Группа удалена");
      };
    }
  });
}

function itemModal(id,gidDefault,normDefault){
  const it=id?S.items[id]:{name:"",groupId:gidDefault||"",emoji:(S.groups[gidDefault]||{}).emoji||"🛒",image:"",need:false,norm:normDefault||0};
  let image=it.image||"";const startImage=image;let uploaded=[];
  const gs=groupsSorted().filter(g=>g.id);
  openPanel(`<h2>${id?"Товар":"Новый товар"}</h2>
    <form id="itf" class="fld" style="gap:12px">
      <div class="fld"><label for="iName">Название</label><input id="iName" required value="${esc(it.name)}" placeholder="Например, корм для кошки"></div>
      <div class="fld"><label for="iNote">Заметка (попадёт в список в скобках)</label><input id="iNote" value="${esc(it.note||"")}" placeholder="например, Сонечко или Хмаринка"></div>
      <div class="fld"><label for="iGroup">Группа</label><select id="iGroup">${gs.map(g=>`<option value="${esc(g.id)}"${g.id===it.groupId?" selected":""}>${esc(g.emoji||"")} ${esc(g.name)}</option>`).join("")}</select></div>
      <div class="grid2"><div class="fld"><label for="iNorm">Заначка: норма, шт</label><input id="iNorm" type="number" min="0" inputmode="numeric" value="${esc(it.norm||"")}" placeholder="не отслеживать"></div>
      <div class="fld"><label for="iEvery">Напоминать раз в, дней</label><input id="iEvery" type="number" min="1" inputmode="numeric" value="${esc(it.checkEvery||14)}"></div></div>
      <div class="fld"><label for="iStore">Где покупать</label><select id="iStore"><option value="">Где угодно</option>${storesSorted().map(s=>`<option value="${esc(s.id)}"${s.id===it.storeId?" selected":""}>${esc(s.emoji||"")} ${esc(s.name)}</option>`).join("")}</select></div>
      <div class="fld"><label>Картинка</label><div class="photo"><div class="pic" id="iPrev"></div>
        ${assets?`<label class="btn" for="iFile">Загрузить фото</label><input id="iFile" type="file" accept="image/*" hidden><button type="button" class="btn ghost" id="iNoPhoto"${image?"":" hidden"}>Убрать фото</button>`:`<span class="qty">Можно выбрать значок ниже</span>`}</div></div>
      <div class="fld"><label for="iEm">Значок (если нет фото)</label><input id="iEm" value="${esc(it.emoji||"")}" maxlength="8">${emojiPicker(it.emoji)}</div>
      ${id&&it.oneOff?`<div class="fld"><label><input type="checkbox" id="iKeep" style="width:auto"> Сохранить в справочник как постоянный товар</label></div>`:""}
      <div class="mact">${id?`<button type="button" class="btn danger left" id="iDel">Удалить</button>`:""}<button type="button" class="btn" data-close>Отмена</button><button class="btn pri" type="submit" id="iSave">Сохранить</button></div>
    </form>`,m=>{
    const em=m.querySelector("#iEm"),prev=m.querySelector("#iPrev");
    const paint=()=>{prev.innerHTML=image?`<img src="${esc(imgSrc(image))}" alt="">`:esc(em.value||"🛒");const nb=m.querySelector("#iNoPhoto");if(nb)nb.hidden=!image};
    paint();em.addEventListener("input",paint);wireEmoji(m,em);
    if(!id)m.querySelector("#iName").focus();
    const file=m.querySelector("#iFile");
    if(file)file.addEventListener("change",async()=>{
      const f=file.files[0];if(!f)return;
      const save=m.querySelector("#iSave");save.disabled=true;save.textContent="Загружаю фото…";
      try{const blob=await shrink(f);const r=await assets.upload(blob,{type:"image/jpeg"});image=r.id;uploaded.push(r.id);paint()}
      catch(e){console.error(e);toast(e&&e.code==="too_large"?"Фото слишком большое":"Не получилось загрузить фото")}
      save.disabled=false;save.textContent="Сохранить";file.value="";
    });
    const nb=m.querySelector("#iNoPhoto");if(nb)nb.onclick=()=>{image="";paint()};
    // a cancelled dialog leaves no orphan uploads behind
    onClose=()=>{uploaded.filter(x=>x!==image||!committed).forEach(x=>assets&&assets.delete(x).catch(()=>{}))};
    let committed=false;
    m.querySelector("#itf").addEventListener("submit",e=>{
      e.preventDefault();
      const name=m.querySelector("#iName").value.trim();if(!name)return;
      const data={name,note:m.querySelector("#iNote").value.trim(),groupId:m.querySelector("#iGroup").value,emoji:em.value.trim()||"🛒",image,storeId:m.querySelector("#iStore").value,
        norm:Math.max(0,Math.round(+m.querySelector("#iNorm").value||0)),checkEvery:Math.max(1,Math.round(+m.querySelector("#iEvery").value||14))};
      const keep=m.querySelector("#iKeep");if(keep&&keep.checked)data.oneOff=false;
      if(id)patch("items",id,data);else put("items",newId(),Object.assign({need:false,inCart:false,oneOff:false},data));
      committed=true;
      if(startImage&&startImage!==image&&assets)assets.delete(startImage).catch(()=>{});
      closeModal();
    });
    const delB=m.querySelector("#iDel");
    if(delB){let armed=false;delB.onclick=()=>{
      if(!armed){armed=true;delB.textContent="Точно удалить?";return}
      committed=true;image="";
      if(startImage&&assets)assets.delete(startImage).catch(()=>{});
      closeModal();del("items",id);toast("Товар удалён");
    }}
  });
}

function storesModal(){
  const list=storesSorted();
  openPanel(`<h2>Магазины</h2>
    <div>${list.map(s=>{const u=safeUrl(s.url);const n=Object.values(S.items).filter(i=>i.storeId===s.id).length;
      return `<div class="srow"><span style="font-size:20px">${esc(s.emoji||"🏬")}</span><span class="nm"><b>${esc(s.name)}</b><span class="meta"><span>товаров: ${n}</span>${u?`<a class="slink" href="${esc(u)}" target="_blank" rel="noopener">сайт ↗</a>`:""}</span></span><button class="edit" data-store="${esc(s.id)}" aria-label="Изменить">${editSvg}</button></div>`}).join("")||'<p class="qty">Магазинов пока нет.</p>'}</div>
    <div class="mact"><button type="button" class="btn left" data-store="">+ Магазин</button><button type="button" class="btn pri" data-close>Готово</button></div>`,m=>{
    m.addEventListener("click",e=>{const b=e.target.closest("[data-store]");if(b)storeModal(b.dataset.store||null)});
  });
}
function storeModal(sid){
  const s=sid?S.stores[sid]:{name:"",emoji:"🏬",url:"",searchUrl:""};
  const n=sid?Object.values(S.items).filter(i=>i.storeId===sid).length:0;
  openPanel(`<h2>${sid?"Магазин":"Новый магазин"}</h2>
    <form id="sf" class="fld" style="gap:12px">
      <div class="fld"><label for="sName">Название</label><input id="sName" required value="${esc(s.name)}" placeholder="Например, EVA"></div>
      <div class="fld"><label for="sEm">Значок</label><input id="sEm" value="${esc(s.emoji||"")}" maxlength="8"></div>
      <div class="fld"><label for="sUrl">Сайт</label><input id="sUrl" type="url" value="${esc(s.url||"")}" placeholder="https://..."></div>
      <div class="fld"><label for="sSearch">Ссылка поиска (вместо слова — {q})</label><input id="sSearch" value="${esc(s.searchUrl||"")}" placeholder="https://site.ua/search?q={q}"><span class="qty">По ней у каждого товара будет кнопка «найти на сайте».</span></div>
      <div class="mact">${sid?`<button type="button" class="btn danger left" id="sDel">Удалить</button>`:""}<button type="button" class="btn" id="sBack">Назад</button><button class="btn pri" type="submit">Сохранить</button></div>
    </form>`,m=>{
    m.querySelector("#sBack").onclick=storesModal;
    m.querySelector("#sf").addEventListener("submit",async e=>{
      e.preventDefault();
      const name=m.querySelector("#sName").value.trim();if(!name)return;
      const data={name,emoji:m.querySelector("#sEm").value.trim(),url:m.querySelector("#sUrl").value.trim(),searchUrl:m.querySelector("#sSearch").value.trim()};
      if(sid)await patch("stores",sid,data);
      else{const max=Math.max(0,...Object.values(S.stores).map(x=>x.order||0));await put("stores",newId(),Object.assign({order:max+1},data))}
      storesModal();
    });
    const delB=m.querySelector("#sDel");
    if(delB){let armed=false;delB.onclick=async()=>{
      if(!armed){armed=true;delB.textContent=n?`Удалить? ${n} тов. станут «где угодно»`:"Точно удалить?";return}
      for(const [id,it] of Object.entries(S.items))if(it.storeId===sid)await patch("items",id,{storeId:""});
      await del("stores",sid);storesModal();
    }}
  });
}

function shrink(file){
  return new Promise((res,rej)=>{
    const img=new Image(),url=URL.createObjectURL(file);
    img.onload=()=>{const max=480,k=Math.min(1,max/Math.max(img.width,img.height));
      const c=document.createElement("canvas");c.width=Math.round(img.width*k);c.height=Math.round(img.height*k);
      c.getContext("2d").drawImage(img,0,0,c.width,c.height);URL.revokeObjectURL(url);
      c.toBlob(b=>b?res(b):rej(new Error("encode")),"image/jpeg",.85)};
    img.onerror=()=>{URL.revokeObjectURL(url);rej(new Error("decode"))};
    img.src=url;
  });
}

let tt=null;
function toast(msg){let el=$(".toast");if(!el){el=document.createElement("div");el.className="toast";el.setAttribute("role","status");document.body.appendChild(el)}el.textContent=msg;clearTimeout(tt);tt=setTimeout(()=>el.remove(),/^Не удалось/.test(msg)?7000:2200)}

if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
})();
