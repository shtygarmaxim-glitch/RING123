(function () {
  const socketRef = (typeof socket !== "undefined") ? socket : (window.__RING_SOCKET || null);
  const tgRef = window.Telegram && Telegram.WebApp;
  const q = id => document.getElementById(id);
  const root = q("iceArenaGame");
  if (!root || !socketRef) return;

  const arena = q("iceArenaBoard"), puck = q("icePuck"), puckImg = puck.querySelector(".puck-img"), arrow = puck.querySelector(".ice-arrow"), ripple = puck.querySelector(".puck-ripple"), zoneMap = q("iceZoneMap"), legend = q("iceLegend"), winnerEl = q("iceWinner"),
    statusEl = q("iceStatus"), poolEl = q("icePool"), joinBtn = q("iceJoinBtn"), betInput = q("iceBetAmt"), stakeInfo = q("iceStakeInfo"),
    anomalyBadge = q("iceAnomalyBadge"), anomalyIcon = anomalyBadge.querySelector(".ab-icon");
  const APPEAR = 2000, SPIN = 3400, HOLD = 700, INTRO = SPIN + HOLD, BASE_FLIGHT = 7000, CLOSE = 1000, PUCK = 24, S = 100, STILL_HOLD = 400;
  let W = arena.clientWidth || 358;
  let me = String(tgRef?.initDataUnsafe?.user?.id || "");
  let st = {status:"waiting",players:[],online:0,id:"-",now:Date.now(),endsAt:0,startAt:0,winnerId:null,seed:null,hash:null,anomaly:null};
  let L = [], plan = null, planFor = null, finished = false, phase = "", cam = null, skew = 0;
  let raceTrackEl = null, raceOffset = 0;
  const RACE_MS = 3600;
  const fmt = v => String(+Number(v).toFixed(3));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;", "'":"&#039;"}[c]));

  function toastLocal(msg){ try{ toast(msg); }catch{ /* main app toast is expected */ } }
  function currentBalance(){
    const n = Number(String(q("balance")?.textContent || "0").replace(/[^0-9.,-]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  }
  function place(x,y){ puck.style.transform = `translate3d(${(x*W/100-PUCK/2).toFixed(2)}px,${(y*W/100-PUCK/2).toFixed(2)}px,0)`; }
  window.addEventListener("resize", () => { W = arena.clientWidth || W; });
  puckImg.addEventListener("error",()=>puck.classList.add("fallback"),{once:true});
  puckImg.addEventListener("load",()=>puck.classList.remove("fallback"));
  place(50,50); puck.style.visibility = "hidden";

  function iceAvatar(p, cls="ice-zone-av", size=30){
    const initial = () => { const d=document.createElement("div"); d.className=cls; d.style.width=d.style.height=size+"px"; d.style.background=p.color||"#ff1231"; d.style.fontSize=Math.max(9,size*.42)+"px"; d.textContent=(p.name||"?").replace(/^@/,'')[0]?.toUpperCase()||"?"; return d; };
    if(p.photo){ const el=document.createElement("img"); el.className=cls; el.style.width=el.style.height=size+"px"; el.src=p.photo; el.referrerPolicy="no-referrer"; el.onerror=()=>el.replaceWith(initial()); return el; }
    return initial();
  }
  function iceAvatarForLegend(p){
    const el=document.createElement(p.photo?"img":"div"); el.className="ice-player-av"; el.style.background=p.color||"#ff1231";
    if(p.photo){el.src=p.photo;el.referrerPolicy="no-referrer";el.onerror=()=>{el.outerHTML=`<span class="ice-player-av" style="background:${p.color||"#ff1231"}">${esc((p.name||"?")[0])}</span>`};}
    else el.textContent=(p.name||"?")[0]?.toUpperCase()||"?";
    return el;
  }

  function clip(poly,a,b,c){const out=[];for(let i=0;i<poly.length;i++){const p=poly[i],r=poly[(i+1)%poly.length],dp=a*p[0]+b*p[1]-c,dr=a*r[0]+b*r[1]-c;if(dp<=0)out.push(p);if(dp*dr<0){const t=dp/(dp-dr);out.push([p[0]+(r[0]-p[0])*t,p[1]+(r[1]-p[1])*t]);}}return out;}
  function cells(){return L.map(p=>{let poly=[[0,0],[S,0],[S,S],[0,S]];for(const o of L){if(o===p||!poly.length)continue;poly=clip(poly,2*(o.sx-p.sx),2*(o.sy-p.sy),o.sx*o.sx+o.sy*o.sy-p.sx*p.sx-p.sy*p.sy+p.w-o.w);}return poly;});}
  function info(poly){let A=0,cx=0,cy=0;for(let i=0;i<poly.length;i++){const p=poly[i],q=poly[(i+1)%poly.length],f=p[0]*q[1]-q[0]*p[1];A+=f;cx+=(p[0]+q[0])*f;cy+=(p[1]+q[1])*f;}A/=2;return A>1e-9?{A,cx:cx/(6*A),cy:cy/(6*A)}:{A:0,cx:50,cy:50};}
  function inr(poly,cx,cy){let m=1e9;for(let i=0;i<poly.length;i++){const p=poly[i],q=poly[(i+1)%poly.length],dx=q[0]-p[0],dy=q[1]-p[1],l=Math.hypot(dx,dy);if(l>1e-6)m=Math.min(m,Math.abs(dx*(cy-p[1])-dy*(cx-p[0]))/l);}return m;}
  function solve(){
    if(!L.length)return;
    const sum=L.reduce((s,p)=>s+p.stake,0)||1;
    for(let it=0;it<400;it++){
      const inf=cells().map(info);
      L.forEach((p,i)=>{const e=p.stake/sum*S*S-inf[i].A,d=Math.sign(e);p.step=Math.min(3000,Math.max(.02,p.step*(d===p.dir?1.25:.5)));p.dir=d;p.w+=d*Math.min(p.step,Math.abs(e)*3);if(it<25&&inf[i].A>0){p.sx+=(inf[i].cx-p.sx)*.3;p.sy+=(inf[i].cy-p.sy)*.3;}});
      const m=L.reduce((s,p)=>s+p.w,0)/L.length;L.forEach(p=>p.w-=m);
    }
  }
  function layout(){L=st.players.map(p=>({id:p.id,stake:Number(p.stake||0),sx:Number(p.sx||50),sy:Number(p.sy||50),w:0,step:200,dir:0}));if(L.length)solve();}
  function buildMosaic(){
    const frag=document.createDocumentFragment(),cs=L.length?cells():[];const zones=[];
    st.players.map((p,i)=>i).sort((a,b)=>(st.players[a].id===me?1:0)-(st.players[b].id===me?1:0)).forEach(i=>{
      const p=st.players[i], poly=cs[i], inf=info(poly), rr=inr(poly,inf.cx,inf.cy);
      const el=document.createElement("div");el.className="ice-zone"+(p.id===me?" mine":"");
      el.innerHTML=`<svg viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points="${poly.map(v=>v[0].toFixed(2)+","+v[1].toFixed(2)).join(" ")}" fill="${p.color||"#ff1231"}"/></svg>`;
      const d=Math.min(46,rr*W/100*1.4);if(d>=14){const av=iceAvatar(p,"ice-zone-av",Math.round(d));av.style.left=inf.cx+"%";av.style.top=inf.cy+"%";el.append(av);}
      frag.append(el);zones.push({p,el});
    });
    return {frag,zones};
  }
  function render(){
    zoneMap.innerHTML="";legend.innerHTML="";
    const sum=L.reduce((s,p)=>s+p.stake,0);
    const racing=st.anomaly==="race"&&(st.status==="running"||st.status==="result");
    const {frag,zones}=buildMosaic();zones.forEach(({p,el})=>p.zone=el);
    if(racing){const track=document.createElement("div");track.className="race-track";const f1=document.createElement("div");f1.className="race-frame";f1.append(frag);const f2=document.createElement("div");f2.className="race-frame";f2.innerHTML=f1.innerHTML;track.append(f1,f2);zoneMap.append(track);raceTrackEl=track;track.style.transform=`translateY(${(-raceOffset/100*W).toFixed(2)}px)`;}
    else{zoneMap.append(frag);raceTrackEl=null;}
    st.players.forEach(p=>{const row=document.createElement("div");row.className="ice-player";row.append(iceAvatarForLegend(p));row.insertAdjacentHTML("beforeend",`<span>${esc(p.name)}</span><b>${fmt(p.stake)} · ${(sum? p.stake/sum*100:0).toFixed(1)}%</b>`);legend.append(row);});
    poolEl.textContent=fmt(sum);
    if(finished)applyResult();
    ui();
  }
  function applyResult(){
    st.players.forEach(p=>p.zone&&p.zone.classList.add(p.id===st.winnerId?"winner-zone":"loser"));
    const w=st.players.find(p=>p.id===st.winnerId);if(!w)return;const pool=st.players.reduce((s,p)=>s+p.stake,0);
    winnerEl.innerHTML=`<div><b>${esc(w.name)}</b><small>Победитель · +${fmt(pool)} ⭐</small></div>`;winnerEl.classList.add("show");
  }
  function ui(){
    const now=Date.now()+skew;let txt="",can=false;
    if(st.status==="waiting"){txt=st.players.length?"Ждём 2-го игрока":"Набор игроков";can=true;}
    else if(st.status==="countdown"){const left=st.endsAt-now;if(left>CLOSE){txt="Начало через 00:"+String(Math.ceil(left/1000)).padStart(2,"0");can=true;}else txt="Ставки закрыты";}
    else if(st.status==="running")txt=phase==="rushing"?"Шайба на льду":"Раунд начинается";else txt="Раунд завершён";
    statusEl.textContent=txt;joinBtn.disabled=!can||!me||!tgRef?.initData;
    const mine=me&&st.players.find(p=>String(p.id)===String(me));stakeInfo.textContent=mine?"Ваша: "+fmt(mine.stake):"";
    q("iceStatusOverlay").textContent=txt;
  }
  setInterval(ui,200);

  function rng(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
  function sim(x,y,ang,spd,flightMs,n){let vx=Math.cos(ang)*spd,vy=Math.sin(ang)*spd;const dt=1/60,decay=4.5/(flightMs/1000),pts=[[x,y]];for(let i=1;i<=n;i++){const boost=1+3*Math.exp(-((i-1)*dt)/.4);x+=vx*dt*boost;y+=vy*dt*boost;let bx=false,by=false;if(x<0){x=0;if(vx<0){vx=Math.abs(vx)*.78;bx=true;}}else if(x>100){x=100;if(vx>0){vx=-Math.abs(vx)*.78;bx=true;}}if(y<0){y=0;if(vy<0){vy=Math.abs(vy)*.78;by=true;}}else if(y>100){y=100;if(vy>0){vy=-Math.abs(vy)*.78;by=true;}}if(bx||by){const s=Math.hypot(vx,vy)||1,m=.37*s,ax=bx?(x<50?1:-1):0,ay=by?(y<50?1:-1):0;let nx=vx,ny=vy;if(ax&&ax*nx<m){nx=ax*m;ny=(Math.sign(ny)||1)*Math.sqrt(Math.max(0,s*s-nx*nx));}if(ay&&ay*ny<m){ny=ay*m;nx=(Math.sign(nx)||1)*Math.sqrt(Math.max(0,s*s-ny*ny));}vx=nx;vy=ny;}if((x<12||x>88)&&(y<12||y>88)){const s0=Math.hypot(vx,vy);vx+=(50-x)*.02*s0*dt;vy+=(50-y)*.02*s0*dt;const s1=Math.hypot(vx,vy)||1;vx*=s0/s1;vy*=s0/s1;}const f=Math.exp(-decay*dt);vx*=f;vy*=f;pts.push([x,y]);}return pts;}
  function getWinnerAt(x,y){let best=L[0],bv=Infinity;for(const p of L){const v=(x-p.sx)**2+(y-p.sy)**2-p.w;if(v<bv){bv=v;best=p;}}return best;}
  function fallbackPlan(){
    const target=st.players.find(p=>String(p.id)===String(st.winnerId))||st.players[0]||{sx:72,sy:55};
    const sp=[50,50],ep=[Number(target.sx)||72,Number(target.sy)||55],n=420,pts=[];
    for(let i=0;i<=n;i++){const u=i/n,e=u*u*(3-2*u);pts.push([sp[0]+(ep[0]-sp[0])*e,sp[1]+(ep[1]-sp[1])*e]);}
    return {sp,pts,ang:0,sa:0,flightMs:7000,n};
  }

  function buildPlan(){
    try { if(st.anomaly==="redo")return buildRedoPlan();
    const flightMs=BASE_FLIGHT,n=Math.round(flightMs/1000*60);let best=null;
    for(let k=0;k<4000;k++){
      const seedNum=parseInt(String(st.seed||"0").slice(0,8),16)||0,r=rng((seedNum+k*7919)>>>0),sx=12+r()*76,sy=14+r()*72,qdir=Math.floor(r()*4),ang=(qdir*90+24+r()*42)*Math.PI/180,spd=750+r()*160,sa=r()*360,pts=sim(sx,sy,ang,spd,flightMs,n);best={sp:[sx,sy],pts,ang,sa,flightMs,n};const e=pts[n];if(getWinnerAt(e[0],e[1])?.id===st.winnerId)break;
    }
    const fa=best.ang*180/Math.PI+90;best.fa=fa;best.ea=best.sa+720+((((fa-best.sa)%360)+360)%360);return best;
    } catch (e) { return fallbackPlan(); }
  }
  function buildRedoPlan(){
    const seedNum=parseInt(String(st.seed||"0").slice(0,8),16)||0,r1=rng((seedNum^0x1a2b3c4d)>>>0),flight1Ms=BASE_FLIGHT,n1=Math.round(flight1Ms/1000*60),sx1=12+r1()*76,sy1=14+r1()*72,q1=Math.floor(r1()*4),ang1=(q1*90+24+r1()*42)*Math.PI/180,spd1=750+r1()*160,sa1=r1()*360,pts1=sim(sx1,sy1,ang1,spd1,flight1Ms,n1),stop=pts1[n1],flight2Ms=BASE_FLIGHT,n2=Math.round(flight2Ms/1000*60);let best2=null;
    for(let k=0;k<4000;k++){const r=rng((seedNum+1+k*7919)>>>0),ang=r()*Math.PI*2,spd=750+r()*160,sa=r()*360,pts=sim(stop[0],stop[1],ang,spd,flight2Ms,n2);best2={sp:stop,pts,ang,sa,flightMs:flight2Ms,n:n2};const e=pts[n2];if(getWinnerAt(e[0],e[1])?.id===st.winnerId)break;}
    const fa1=ang1*180/Math.PI+90,ea1=sa1+720+((((fa1-sa1)%360)+360)%360),fa2=best2.ang*180/Math.PI+90;best2.ea=best2.sa+720+((((fa2-best2.sa)%360)+360)%360);return{mode:"redo",phase1:{sp:[sx1,sy1],pts:pts1,sa:sa1,ea:ea1,flightMs:flight1Ms,n:n1},stop,phase2:best2};
  }
  function setPhase(p){if(p===phase)return;phase=p;puck.classList.toggle("choosing",p==="choosing");puck.classList.toggle("aiming",p==="aiming");puck.classList.toggle("rushing",p==="rushing");}
  const clamp01=x=>Math.max(0,Math.min(1,x)), easeOut=x=>1-Math.pow(1-x,3);
  function fx(t,sa,ea){const e=easeOut(clamp01(t/APPEAR)),s=.45+.55*e;puckImg.style.opacity=e.toFixed(3);puckImg.style.transform=`scale(${s.toFixed(3)})`;const r=clamp01(t/800);ripple.style.opacity=(.7*(1-r)*(1-r)).toFixed(3);ripple.style.transform=`translate(-50%,-50%) scale(${(.7+1.6*easeOut(r)).toFixed(3)})`;const ang=sa+(ea-sa)*easeOut(clamp01(t/SPIN));const pop=1+.25*Math.sin(Math.PI*clamp01((t-SPIN)/350));arrow.style.opacity=(clamp01(t/150)*(1-clamp01((t-INTRO)/250))).toFixed(3);arrow.style.transform=`rotate(${ang.toFixed(2)}deg) scale(${(s*pop).toFixed(3)})`;}
  function applyCamZoom(ft,flightMs,x,y){const zt=Math.max(0,Math.min(1,(ft-(flightMs-3000))/3000));if(zt>0){if(!cam){cam={x,y};arena.style.transition="none";}cam.x+=(x-cam.x)*.12;cam.y+=(y-cam.y)*.12;const e=zt*zt*(3-2*zt),sc=1+.32*e,lim=(sc-1)*50;const tx=Math.max(-lim,Math.min(lim,(50-cam.x)*sc)),ty=Math.max(-lim,Math.min(lim,(50-cam.y)*sc));arena.style.transform=`translate(${tx}%,${ty}%) scale(${sc})`;}}
  function updateRaceScroll(t){if(!raceTrackEl||finished)return;raceOffset=(Math.max(0,t)%RACE_MS)/RACE_MS*100;raceTrackEl.style.transform=`translateY(${(-raceOffset/100*W).toFixed(2)}px)`;}
  function frame(t){
    if(plan.mode==="redo"){frameRedo(t);return;}
    updateRaceScroll(t); if(finished)return;
    if(t<0){puck.style.visibility="hidden";place(plan.sp[0],plan.sp[1]);fx(0,plan.sa,plan.ea);return;}
    puck.style.visibility="visible";fx(t,plan.sa,plan.ea);
    if(t<INTRO){setPhase(t<SPIN?"choosing":"aiming");place(plan.sp[0],plan.sp[1]);return;}
    setPhase("rushing");
    const ft=Math.min(Math.max(0,t-INTRO),plan.flightMs);
    const idx=ft/1000*60, i=Math.min(plan.n-1,Math.max(0,Math.floor(idx))), f=Math.max(0,Math.min(1,idx-i));
    const a=plan.pts[i]||plan.pts[plan.pts.length-1], b=plan.pts[i+1]||a;
    const x=a[0]+(b[0]-a[0])*f,y=a[1]+(b[1]-a[1])*f;place(x,y);applyCamZoom(ft,plan.flightMs,x,y);
    if(ft>=plan.flightMs&&!finished){finished=true;applyResult();}
  }
  function frameRedo(t){
    const p1=plan.phase1,p2=plan.phase2,T1=INTRO,T2=T1+p1.flightMs,T3=T2+STILL_HOLD,T4=T3+INTRO;
    if(finished)return;
    if(t<0){puck.style.visibility="hidden";place(p1.sp[0],p1.sp[1]);fx(0,p1.sa,p1.ea);return;}
    puck.style.visibility="visible";
    if(t<T1){fx(t,p1.sa,p1.ea);setPhase(t<SPIN?"choosing":"aiming");place(p1.sp[0],p1.sp[1]);return;}
    if(t<T2){setPhase("rushing");const ft=Math.min(Math.max(0,t-T1),p1.flightMs),idx=ft/1000*60,i=Math.min(p1.n-1,Math.max(0,Math.floor(idx))),f=Math.max(0,Math.min(1,idx-i));const a=p1.pts[i]||p1.pts[p1.pts.length-1],b=p1.pts[i+1]||a,x=a[0]+(b[0]-a[0])*f,y=a[1]+(b[1]-a[1])*f;place(x,y);arrow.style.opacity=0;ripple.style.opacity=0;applyCamZoom(ft,p1.flightMs,x,y);return;}
    if(t<T3){if(cam){cam=null;arena.style.transition="";arena.style.transform="scale(1)";}setPhase("");place(plan.stop[0],plan.stop[1]);arrow.style.opacity=0;ripple.style.opacity=0;return;}
    if(t<T4){const lt=Math.min(Math.max(0,t-T3),INTRO);setPhase(lt<SPIN?"choosing":"aiming");puckImg.style.opacity="1";puckImg.style.transform="scale(1)";const ang2=p2.sa+(p2.ea-p2.sa)*easeOut(clamp01(lt/SPIN)),pop2=1+.25*Math.sin(Math.PI*clamp01((lt-SPIN)/350));arrow.style.opacity=(clamp01(lt/150)*(1-clamp01((lt-INTRO)/250))).toFixed(3);arrow.style.transform=`rotate(${ang2.toFixed(2)}deg) scale(${pop2.toFixed(3)})`;ripple.style.opacity="0";place(p2.sp[0],p2.sp[1]);return;}
    setPhase("rushing");const ft=Math.min(Math.max(0,t-T4),p2.flightMs),idx=ft/1000*60,i=Math.min(p2.n-1,Math.max(0,Math.floor(idx))),f=Math.max(0,Math.min(1,idx-i));const a=p2.pts[i]||p2.pts[p2.pts.length-1],b=p2.pts[i+1]||a,x=a[0]+(b[0]-a[0])*f,y=a[1]+(b[1]-a[1])*f;place(x,y);arrow.style.opacity=0;ripple.style.opacity=0;applyCamZoom(ft,p2.flightMs,x,y);if(ft>=p2.flightMs&&!finished){finished=true;applyResult();}
  }
  let lastAnimT=-Infinity;
  function loop(){
    requestAnimationFrame(loop);
    if((st.status!=="running"&&st.status!=="result")||!st.startAt||!L.length)return;
    if(planFor!==st.id||!plan){plan=buildPlan();planFor=st.id;finished=false;cam=null;lastAnimT=-Infinity;}
    const raw=Date.now()+skew-st.startAt;
    const visualT=Math.max(lastAnimT,raw); lastAnimT=visualT;
    const endT=plan.mode==="redo" ? (INTRO+plan.phase1.flightMs+STILL_HOLD+INTRO+plan.phase2.flightMs) : (INTRO+plan.flightMs);
    if(st.status==="result" && visualT<endT) { frame(endT); return; }
    if(plan.mode==="redo") frameRedo(Math.min(visualT,endT)); else frame(Math.min(visualT,endT));
  }
  requestAnimationFrame(loop);
  function resetVisual(){plan=null;planFor=null;finished=false;cam=null;phase="";lastAnimT=-Infinity;arena.style.transition="";arena.style.transform="scale(1)";puck.classList.remove("choosing","aiming","rushing");winnerEl.classList.remove("show");winnerEl.innerHTML="";W=arena.clientWidth||W;place(50,50);puck.style.visibility="hidden";}

  const ANOMALY_NAMES={race:"Гонка",mirage:"Hide",redo:"Вторая жизнь!"}, ANOMALY_ICON={race:"ic-race",mirage:"ic-mirage",redo:"ic-redo"}, ANOMALY_CYCLE=["ic-race","ic-mirage","ic-redo"];
  let shownAnomalyFor=null,anomalySpin=null,anomalyRollT=null;
  let shownResultRoundId=null;
  function updateAnomalyUI(){
    if(st.status==="waiting"||st.status==="countdown"){shownAnomalyFor=null;clearInterval(anomalySpin);clearTimeout(anomalyRollT);anomalyBadge.classList.remove("show","rolling","settled");root.classList.remove("mirage-active");return;}
    root.classList.toggle("mirage-active",st.anomaly==="mirage"&&st.status==="running");
    if(shownAnomalyFor===st.id)return;shownAnomalyFor=st.id;clearInterval(anomalySpin);clearTimeout(anomalyRollT);anomalyBadge.classList.remove("settled");
    if(st.anomaly&&ANOMALY_ICON[st.anomaly]){anomalyBadge.classList.add("show","rolling");let i=0;anomalyIcon.classList.remove(...ANOMALY_CYCLE,"flip-out");anomalyIcon.classList.add(ANOMALY_CYCLE[0]);anomalySpin=setInterval(()=>{anomalyIcon.classList.add("flip-out");setTimeout(()=>{anomalyIcon.classList.remove(...ANOMALY_CYCLE);anomalyIcon.classList.add(ANOMALY_CYCLE[++i%ANOMALY_CYCLE.length]);anomalyIcon.classList.remove("flip-out");},90);},170);anomalyRollT=setTimeout(()=>{clearInterval(anomalySpin);anomalyIcon.classList.remove(...ANOMALY_CYCLE,"flip-out");anomalyIcon.classList.add(ANOMALY_ICON[st.anomaly]);anomalyBadge.classList.remove("rolling");anomalyBadge.classList.add("settled");toastLocal("Аномалия! "+ANOMALY_NAMES[st.anomaly]);},850);}
  }

  function shortHex(s){s=String(s||"");return s.length>10?s.slice(0,4)+"…"+s.slice(-4):s;}
  let hData={list:[]},curGame=null;
  function renderHistory(h){
    hData=h||{list:[]};const list=q("iceHistoryList");list.innerHTML="";if(!hData.list?.length){list.innerHTML='<div class="ice-hint">Игр пока не было</div>';return;}
    hData.list.forEach(g=>{const row=document.createElement("button");row.type="button";row.className="ice-history-row";const p=(g.players||[]).find(x=>x.id===g.winnerId)||(g.players||[])[0]||{};const when=new Date(g.createdAt).toLocaleString("ru-RU",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"});row.innerHTML=`<span class="ice-player-av" style="background:${p.color||"#ff1231"}">${esc((p.name||"?")[0])}</span><span class="name">${esc(p.name||"Игрок")}<small>${when} · ${(g.players||[]).length} игроков</small></span><span class="amt">+${fmt(g.payout||g.bank||0)} ⭐</span>`;row.onclick=()=>openGame(g);list.append(row);});
  }
  function openGame(g){
    curGame=g;q("iceGameId").textContent=g.id;q("iceGameDate").textContent=new Date(g.createdAt).toLocaleString("ru-RU")+(g.anomaly&&ANOMALY_NAMES[g.anomaly]?" · "+ANOMALY_NAMES[g.anomaly]:"");q("iceGameHash").textContent=shortHex(g.hash);q("iceGameSeed").textContent=shortHex(g.seed);const pool=g.players.reduce((s,p)=>s+Number(p.stake||p.bet||0),0);const list=q("iceGamePlayers");list.innerHTML="";
    [...(g.players||[])].sort((a,b)=>Number(b.stake||b.bet||0)-Number(a.stake||a.bet||0)).forEach(p=>{const isWin=p.id===g.winnerId;const row=document.createElement("div");row.className="ice-game-player"+(isWin?" win":"");row.append(iceAvatar({...p,stake:Number(p.stake||p.bet||0)},"ice-zone-av",32));row.insertAdjacentHTML("beforeend",`<span class="gname"><b>${esc(p.name||"Игрок")}</b><small>${pool?((Number(p.stake||p.bet||0)/pool)*100).toFixed(2):"0.00"}%</small></span><span class="gamt">${isWin?"+":""}${fmt(isWin?g.payout:(p.stake||p.bet||0))} ⭐</span>`);list.append(row);});
    q("iceLegitResult").textContent="";q("iceLegitResult").className="ice-legit-result";q("iceGameModal").classList.add("show");
  }

  q("iceArenaHistory").onclick=()=>{q("iceHistoryModal").classList.add("show");socketRef.emit("ice_request_history");};
  q("iceHistoryClose").onclick=()=>q("iceHistoryModal").classList.remove("show");
  q("iceGameClose").onclick=()=>q("iceGameModal").classList.remove("show");
  q("iceHistoryModal").addEventListener("click",e=>{if(e.target===q("iceHistoryModal"))q("iceHistoryModal").classList.remove("show")});
  q("iceGameModal").addEventListener("click",e=>{if(e.target===q("iceGameModal"))q("iceGameModal").classList.remove("show")});
  document.querySelectorAll(".ice-copy").forEach(btn=>btn.addEventListener("click",()=>{if(!curGame)return;const v=btn.dataset.t==="hash"?curGame.hash:String(curGame.seed||"");if(navigator.clipboard)navigator.clipboard.writeText(v).then(()=>toastLocal("Скопировано")).catch(()=>toastLocal("Не удалось скопировать"));}));
  q("iceLegitCheck").onclick=async()=>{if(!curGame)return;const v=q("iceLegitResult");v.textContent="Проверяем…";v.className="ice-legit-result";try{const buf=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(curGame.seed)));const hex=[...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join("");let x=rng(parseInt(String(curGame.seed).slice(0,8),16)||0)();const pool=curGame.players.reduce((s,p)=>s+Number(p.stake||p.bet||0),0);x*=pool;let w=curGame.players[0];for(const p of curGame.players){const s=Number(p.stake||p.bet||0);if(x<s){w=p;break;}x-=s;}if(hex===curGame.hash&&w?.id===curGame.winnerId){v.textContent="✅ Проверено — сид совпадает с хешем, победитель посчитан честно";v.className="ice-legit-result ok";}else{v.textContent="❌ Проверка не пройдена";v.className="ice-legit-result bad";}}catch{v.textContent="Не удалось проверить в этом браузере";v.className="ice-legit-result bad";}};

  q("iceJoinBtn").onclick=()=>{const amount=Math.round(Number(betInput.value));if(!Number.isInteger(amount)||amount<1)return toastLocal("Ставка — целое число от 1 ⭐");if(amount>currentBalance())return toastLocal("Недостаточно Stars на балансе.");socketRef.emit("ice_bet",{amount});};
  document.querySelectorAll(".ice-arena-stakes button").forEach(b=>b.addEventListener("click",()=>{const cur=Math.round(Number(betInput.value))||1,max=Math.max(1,Math.floor(currentBalance())),act=b.dataset.a;let v=act==="min"?1:act==="max"?max:cur+Number(act);betInput.value=Math.max(1,Math.min(max,v));}));
  betInput.addEventListener("input",()=>{betInput.value=betInput.value.replace(/[^0-9]/g,"");});

  let hintTaps=0,hintTapT=null;const hintEl=q("iceHint"),meowSound=new Audio("/meow.mp3");
  if(hintEl)hintEl.addEventListener("click",()=>{hintTaps++;clearTimeout(hintTapT);hintTapT=setTimeout(()=>hintTaps=0,900);if(hintTaps>=3){hintTaps=0;try{meowSound.currentTime=0;meowSound.play();}catch{}}});

  function openIce(){
    if(!tgRef?.initData)return handleNotTelegram();
    q("gamesList").classList.add("hidden");q("upgradeGame").classList.add("hidden");q("bounceGame").classList.add("hidden");root.classList.remove("hidden");
    W=arena.clientWidth||W;socketRef.emit("ice_request_state");socketRef.emit("ice_request_history");ui();
  }
  function closeIce(){q("iceHistoryModal").classList.remove("show");q("iceGameModal").classList.remove("show");root.classList.add("hidden");q("gamesList").classList.remove("hidden");resetVisual();}
  q("openIceArena").onclick=openIce;q("iceArenaBack").onclick=closeIce;

  socketRef.on("ice_state",m=>{
    if(!m)return;skew=Number(m.now||Date.now())-Date.now();st=m;me=me||String(tgRef?.initDataUnsafe?.user?.id||"");
    if(st.status==="running"||st.status==="result"){puck.style.display="block";}
    if(st.status==="waiting"||st.status==="countdown"){
      resetVisual();
      if(st.status==="waiting" && shownResultRoundId){ const ov=document.getElementById("winnerOverlay"); if(ov) ov.classList.add("hidden"); }
      if(st.status==="waiting") shownResultRoundId=null;
    }
    updateAnomalyUI();layout();render();
  });
  socketRef.on("ice_history",h=>renderHistory(h));
  socketRef.on("ice_error",msg=>{
    const text=String(msg||"");
    if(!/истори/i.test(text)) toastLocal(text||"Ошибка Ice Arena");
    ui();
  });
  socketRef.on("joined",data=>{if(data?.playerId)me=String(data.playerId);});
  socketRef.on("balance_updated",()=>ui());
  socketRef.on("disconnect",()=>{if(!root.classList.contains("hidden"))ui();});
})();
