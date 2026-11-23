"use strict";
/* Tank Arena - authoritative game server: standalone Node.js version */

/* ============ SHARED (identical in worker.js and index.html): constants, seeded arena, tank physics ============ */
const T=80,N=30,WORLD=T*N,TAU=Math.PI*2,STEP=1/60,TICK=0.05;
const clamp=(v,a,b)=>v<a?a:v>b?b:v,rnd=(a,b)=>a+Math.random()*(b-a);
const angDiff=(a,b)=>{let d=(b-a)%TAU;if(d>Math.PI)d-=TAU;else if(d<-Math.PI)d+=TAU;return d};
const idx=(x,y)=>y*N+x,inb=(x,y)=>x>=0&&y>=0&&x<N&&y<N;
const num=(x,d)=>{x=+x;return isFinite(x)?x:(d||0)};
function mul(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const TEAMCOL=['#29f0ff','#ff2e88'],TEAMNAME=['CYAN','MAGENTA'];
const FFACOL=['#29f0ff','#ff2e88','#9dff3a','#ffb020','#b06bff','#ff6a3d','#3a8bff','#ffe94a'];
const BOTNAMES=['VIPER','NOVA','GHOST','RAZOR','HELIX','ONYX','KRAKEN','BLAZE'];
const TANK_R=29,MAXF=235,MAXB=150,TURN=3.2,TURRET_SPD=11,BSPD=1150,RELOAD=.4,MAXHP=6,BDMG=2,RESPAWN=3,MATCH_T=600;
const MODES=[{k:'1v1',n:2,teams:2},{k:'2v2',n:4,teams:2},{k:'4v4',n:8,teams:2},{k:'FFA',n:8,teams:0}];
// index 0-4 are perks, 5-8 are carried traps. d = effect seconds.
const ITEMS=[
 {k:'spd',n:'Speed',c:'#3aa0ff',d:60},{k:'shd',n:'Shield',c:'#ffc83a',d:60},{k:'rate',n:'Rapid fire',c:'#ff6a3d',d:60},
 {k:'regen',n:'Repair',c:'#7dff4a',d:30},{k:'lock',n:'Target lock',c:'#ff2e88',d:30},
 {k:'mine',n:'Landmine',c:'#ff4a2a',d:0},{k:'slow',n:'Slow trap',c:'#8a6bff',d:8},{k:'poison',n:'Poison trap',c:'#b6ff3a',d:8},{k:'smoke',n:'Smoke trap',c:'#c4ccd8',d:30},
 {k:'spread',n:'Triple shot',c:'#ffe94a',d:30},{k:'bounce',n:'Ricochet',c:'#3affd0',d:30},{k:'pierce',n:'Railgun',c:'#e8f4ff',d:30},
 {k:'cloak',n:'Stealth',c:'#9aa8ff',d:20},{k:'emp',n:'EMP blast',c:'#5ad1ff',d:3},{k:'vamp',n:'Vampire',c:'#ff3d6e',d:30},{k:'jam',n:'Jammed',c:'#5ad1ff',d:3},
 {k:'mimic',n:'Mimic crate',c:'#ffc83a',d:0},{k:'portal',n:'Wormhole',c:'#29f0ff',d:0},{k:'tether',n:'Bungee tether',c:'#ff2e88',d:0},{k:'shock',n:'Shock wire',c:'#29f0ff',d:0},
 {k:'grav',n:'Gravity well',c:'#a06bff',d:0},{k:'glitchT',n:'Glitch trap',c:'#3aff7a',d:0},{k:'napalm',n:'Napalm',c:'#ff8a1a',d:0},{k:'repulse',n:'Repulsor',c:'#ff2e88',d:0},
 {k:'decoy',n:'Decoy hologram',c:'#3affd0',d:0},{k:'sentry',n:'Sentry gun',c:'#ff3d3d',d:0},{k:'portalb',n:'Wormhole exit',c:'#ff8a1a',d:0},
 {k:'root',n:'Stunned',c:'#29f0ff',d:1.5},{k:'glitch',n:'Glitched',c:'#3aff7a',d:4},{k:'burn',n:'Burning',c:'#ff8a1a',d:1},{k:'flash',n:'Flashed',c:'#ffffff',d:3},{k:'teth',n:'Tethered',c:'#ff2e88',d:5}];
// 16-25 new carried traps, 26 = second wormhole pad (given after placing the first), 27-31 debuffs only
const TRAPS=[5,6,7,8,16,17,18,19,20,21,22,23,24,25];
const PERKS=[0,1,2,3,4,9,10,11,12,13,14],isPerk=ty=>PERKS.indexOf(ty)>=0; // 9-14 personal perks (13 = instant EMP), 15 = jam debuff only
const FXK=['spd','shd','rate','regen','lock','slow','poison','smoke','spread','bounce','pierce','cloak','vamp','jam','root','glitch','burn','flash','teth']; // flag bit i; bit 20 = spawn shield
const FL_INV=1048576;
const FXS=['SPD','SHD','RAPID','REPAIR','LOCK','SLOW','POISON','SMOKE','TRI','RICO','RAIL','CLOAK','VAMP','JAM','STUN','GLITCH','BURN','FLASH','TETHER']; // short buff labels for phones
const EVN=['sp2','sp','wl','cr','cb','rs','ht','sd','xp','kl','pk','dp','tg','mb','hl','em','po','pb','ty'],EVI={};
for(let i=0;i<EVN.length;i++)EVI[EVN[i]]=i;
const cleanName=n=>String(n||'').toUpperCase().replace(/[^A-Z0-9 _-]/g,'').trim().slice(0,10)||'PILOT';
const fxMul=t=>(t.fx.spd>0?1.4:1)*(t.fx.slow>0?.5:1)*(t.fx.burn>0?.75:1);
const aimAt=(t,o)=>{const lead=Math.hypot(o.x-t.x,o.y-t.y)/BSPD;return Math.atan2(o.y+Math.sin(o.a)*o.v*lead*.6-t.y,o.x+Math.cos(o.a)*o.v*lead*.6-t.x)};

/* Arena: seeded map (every device builds the same one from the seed) + wall collision + tank movement. */
function Arena(){
  const grid=new Uint8Array(N*N),chp=new Uint8Array(N*N),crateOf=new Int16Array(N*N).fill(-1);
  const A={grid,chp,crateOf,mainCells:[],crateCells:[],dirty:true};
  A.setCell=(x,y,t)=>{if(x<=0||y<=0||x>=N-1||y>=N-1)return;grid[idx(x,y)]=t;chp[idx(x,y)]=t===2?3:0;A.dirty=true};
  A.genMap=seed=>{
    const R=mul(seed),setCell=A.setCell;grid.fill(0);chp.fill(0);
    for(let i=0;i<N;i++){grid[idx(i,0)]=1;grid[idx(i,N-1)]=1;grid[idx(0,i)]=1;grid[idx(N-1,i)]=1}
    for(let i=11;i<=18;i++){const g=(i===14||i===15)?2:1;setCell(i,11,g);setCell(i,18,g);setCell(11,i,g);setCell(18,i,g)}
    [[13,13],[16,13],[13,16],[16,16]].forEach(p=>setCell(p[0],p[1],2));
    const core=(x,y)=>x>=9&&x<=20&&y>=9&&y<=20;
    [[4,4,1,1],[25,4,-1,1],[4,25,1,-1],[25,25,-1,-1]].forEach(p=>{const x=p[0],y=p[1],sx=p[2],sy=p[3];setCell(x,y,1);setCell(x+sx,y,1);setCell(x,y+sy,1);setCell(x+2*sx,y,2);setCell(x,y+2*sy,2);setCell(x+sx,y+sy,2)});
    for(let k=0;k<30;k++){const h=R()<.5,len=2+(R()*4|0),t=R()<.4?1:2,x=2+(R()*26|0),y=2+(R()*26|0);
      for(let i=0;i<len;i++){const cx=x+(h?i:0),cy=y+(h?0:i);if(!core(cx,cy))setCell(cx,cy,t)}}
    for(let k=0;k<45;k++){const x=2+(R()*26|0),y=2+(R()*26|0);if(!core(x,y)&&!grid[idx(x,y)])setCell(x,y,R()<.2?1:2)}
    const comp=new Int16Array(N*N).fill(-1),sizes=[],DIRS=[[1,0],[-1,0],[0,1],[0,-1]];
    for(let s=0;s<N*N;s++){if(grid[s]||comp[s]>=0)continue;const id=sizes.length;let n=0;const q=[s];comp[s]=id;
      while(q.length){const c=q.pop();n++;const cx=c%N,cy=(c/N)|0;for(let d=0;d<4;d++){const nx=cx+DIRS[d][0],ny=cy+DIRS[d][1];if(inb(nx,ny)&&!grid[idx(nx,ny)]&&comp[idx(nx,ny)]<0){comp[idx(nx,ny)]=id;q.push(idx(nx,ny))}}}
      sizes.push(n)}
    let best=0;sizes.forEach((n,i)=>{if(n>sizes[best])best=i});
    const mc=[],cc=[];
    for(let i=0;i<N*N;i++){if(grid[i])continue;if(comp[i]===best)mc.push(i);else grid[i]=1}
    for(let i=0;i<N*N;i++)if(grid[i]===2)cc.push(i);
    A.mainCells=mc;A.crateCells=cc;crateOf.fill(-1);for(let k=0;k<cc.length;k++)crateOf[cc[k]]=k;A.dirty=true;
  };
  A.crateStr=()=>{let s='';for(let k=0;k<A.crateCells.length;k++){const i=A.crateCells[k];s+=grid[i]===2?chp[i]:0}return s};
  A.setCrate=(k,v)=>{const i=A.crateCells[k];if(i===undefined)return;
    if(v>0){if(grid[i]!==2||chp[i]!==v){grid[i]=2;chp[i]=v;A.dirty=true}}else if(grid[i]!==0){grid[i]=0;chp[i]=0;A.dirty=true}};
  A.applyCrateStr=s=>{for(let k=0;k<A.crateCells.length&&k<s.length;k++)A.setCrate(k,+s[k]||0)};
  A.solidAt=(px,py)=>{const cx=Math.floor(px/T),cy=Math.floor(py/T);return inb(cx,cy)?grid[idx(cx,cy)]:1};
  A.collideTank=t=>{
    for(let it=0;it<2;it++){
      const cx=Math.floor(t.x/T),cy=Math.floor(t.y/T);
      for(let y=cy-1;y<=cy+1;y++)for(let x=cx-1;x<=cx+1;x++){
        if(!inb(x,y)||!grid[idx(x,y)])continue;
        const rx=x*T,ry=y*T,nx=clamp(t.x,rx,rx+T),ny=clamp(t.y,ry,ry+T),dx=t.x-nx,dy=t.y-ny,d2=dx*dx+dy*dy;
        if(d2>=TANK_R*TANK_R)continue;
        if(d2<1e-6){const l=t.x-rx,r=rx+T-t.x,u=t.y-ry,dn=ry+T-t.y,m=Math.min(l,r,u,dn);
          if(m===l)t.x=rx-TANK_R;else if(m===r)t.x=rx+T+TANK_R;else if(m===u)t.y=ry-TANK_R;else t.y=ry+T+TANK_R}
        else{const d=Math.sqrt(d2),p=TANK_R-d;t.x+=dx/d*p;t.y+=dy/d*p}
      }
    }
  };
  A.moveTank=(t,dt,m)=>{
    const i=t.inp;let thrust=0,turn=0;
    if(i.vec){if(i.mag>.12){const d=angDiff(t.a,Math.atan2(i.vy,i.vx));turn=clamp(d*6,-1,1);thrust=i.mag*clamp(Math.cos(d)*1.5,0,1)}}else{thrust=i.thrust;turn=i.turn}
    const fx=t.fx;if(fx){if(fx.glitch>0){thrust=-thrust;turn=-turn}if(fx.root>0){thrust=0;turn*=.3;t.v*=.5}}   /* glitch trap flips controls, shock wire roots */
    t.a+=turn*TURN*(1-.25*Math.min(1,Math.abs(t.v)/(MAXF*m)))*dt;
    const target=thrust>=0?thrust*MAXF*m:thrust*MAXB*m;
    t.v+=(target-t.v)*(1-Math.exp(-dt*(Math.abs(target)>Math.abs(t.v)?6:9)));
    t.x+=Math.cos(t.a)*t.v*dt;t.y+=Math.sin(t.a)*t.v*dt;A.collideTank(t);
    const d=angDiff(t.ta,i.aim),mx=TURRET_SPD*dt;t.ta+=clamp(d,-mx,mx);
  };
  return A;
}

/* ============ AUTHORITATIVE GAME ENGINE ============
   Runs inside the Cloudflare Durable Object (online) or inside the page (offline practice). Same code, same protocol.
   io.all(str) broadcasts one frame to every player, io.to(id,str) sends to one player, io.kick(id,code,reason) disconnects one.

   SERVER -> CLIENT (text lines; several lines leave as ONE frame joined by "\n", once per 50 ms tick)
     w|id                         welcome, your player id
     L|mode|owner|rq|rr|slots     roster: slots "name,team,bot,id,left;..."   rq/rr = rematch / back-to-room votes "0.2"
     M|mid|seed|mode              match starts: build the map from the seed
     P|phase|tl*10|cd*10          phase 0 lobby 1 countdown 2 play 3 end (sent on change + every second)
     C|crates  c|i,hp;i,hp        all crate hp / changed crates
     S|k,d,lock,traps;...         per-slot kills, deaths, lock target+1, carried traps (only when changed)
     I|id,type,x,y;...            items (only when changed)
     X|id,type,x,y,team,armed;... traps (only when changed)
     u|step|slot,x,y,a,ta,v,hp,fl|slot|...   tanks, integers only. A bare "slot" = unchanged since last tick. Missing slot = dead.
     e|type,x,y,a*1000,s,s2;...   one-shot events (shots, hits, explosions, pickups)
     o|ts                         pong (answered immediately)
     l|text                       lobby notice for one player
   CLIENT -> SERVER
     i|m,a,b,aim*1000,fire,dp     input. m=0 keys: a=thrust b=turn (-1..1).  m=1 stick: a,b = move vector *100
     p|ts  ping    m|mode  b add bot   r|slot remove   t|slot switch team   s start   v|1 rematch  v|2 back to room   q|n team emote (0-5) */
function Engine(io){
  const A=Arena(),grid=A.grid,chp=A.chp,R=Math.round;
  const solidAt=A.solidAt,collideTank=A.collideTank,moveTank=A.moveTank;
  const tanks=[],bullets=[],items=[],traps=[],broken=[],ev=[],crD=[],lastRow=[];
  const ROOM={mode:1,slots:[],owner:''};
  const G={ph:0,cd:0,tl:MATCH_T,itemT:0,seed:1,mid:0};
  const clients=new Map();
  let nextId=1,nextBid=1,stepN=0,tickN=0,acc=0,lastMs=0,rayG=0;
  let lobbyDirty=true,phDirty=true,startDirty=false,lastS='',lastI='',lastX='';

  const md=()=>MODES[ROOM.mode];
  const cap=()=>md().n;
  const teamOf=i=>md().teams?ROOM.slots[i].team:i;
  const humans=()=>ROOM.slots.filter(s=>!s.bot&&!s.left);
  const slotOf=cid=>{for(let i=0;i<ROOM.slots.length;i++)if(ROOM.slots[i].id===cid)return i;return -1};
  const say=(cid,m)=>io.to(cid,'l|'+m);
  const newInp=()=>({thrust:0,turn:0,vec:false,vx:0,vy:0,mag:0,aim:0,fire:false,dp:0});
  const na=a=>{a%=TAU;if(a<0)a+=TAU;return R(a*100)};

  function emit(ty,x,y,a,s,s2){
    let e=EVI[ty]+','+R(x||0)+','+R(y||0)+','+R((a||0)*1000);
    const p=s==null?-1:s,q=s2==null?-1:s2;
    if(p!==-1||q!==-1){e+=','+p;if(q!==-1)e+=','+q}
    ev.push(e);
  }

  /* ---- tanks ---- */
  function makeTank(slot,name,team,bot,cid){
    const c=cid?clients.get(cid):null;
    return{slot,name,team,bot,cid,x:0,y:0,a:0,ta:0,v:0,hp:MAXHP,alive:false,respawnT:0,cd:0,inv:0,kills:0,deaths:0,
      fx:{spd:0,shd:0,rate:0,regen:0,lock:0,slow:0,poison:0,smoke:0,spread:0,bounce:0,pierce:0,cloak:0,vamp:0,jam:0,root:0,glitch:0,burn:0,flash:0,teth:0},regenLeft:0,regenT:0,poisonT:0,lockTgt:null,traps:[],ptT:0,kT:0,kx:0,ky:0,kHit:false,kBy:-1,tA:null,burnT:0,burnBy:-1,dpSeen:c?c.inp.dp:0,
      inp:newInp(),brain:null};
  }
  const flagsOf=t=>{let f=0;for(let i=0;i<FXK.length;i++)if(t.fx[FXK[i]]>0)f|=1<<i;if(t.inv>0)f|=FL_INV;return f};
  function findSpawn(){
    let fb=null;const mc=A.mainCells;
    for(let k=0;k<60;k++){
      const c=mc[(Math.random()*mc.length)|0],cx=c%N,cy=(c/N)|0;
      if(grid[c]||grid[idx(cx+1,cy)]||grid[idx(cx-1,cy)]||grid[idx(cx,cy+1)]||grid[idx(cx,cy-1)])continue;
      const x=(cx+.5)*T,y=(cy+.5)*T;fb=[x,y];let ok=true;const need=k<40?650:260;
      for(const t of tanks)if(t.alive&&Math.hypot(t.x-x,t.y-y)<need){ok=false;break}
      if(ok)return[x,y];
    }
    return fb||[WORLD/2,WORLD/2];
  }
  function respawn(t,first){
    const p=findSpawn();
    t.x=p[0];t.y=p[1];t.a=rnd(0,TAU);t.ta=t.a;t.v=0;t.hp=MAXHP;t.alive=true;t.cd=.3;t.inv=first?4:1.8;
    for(const k of FXK)t.fx[k]=0;t.lockTgt=null;t.tA=null;t.kT=0;t.inp.fire=false;t.inp.aim=t.ta;
    emit('sp',t.x,t.y,0,t.slot);
  }
  function killTank(t,by,kind){
    t.alive=false;t.hp=0;t.respawnT=RESPAWN;t.deaths++;t.v=0;
    for(const k of FXK)t.fx[k]=0;t.traps.length=0;
    if(by&&by!==t&&by.team!==t.team)by.kills++;
    emit('xp',t.x,t.y,0,t.slot);emit('kl',0,0,kind||0,by&&by!==t?by.slot:-1,t.slot);
  }
  function dmg(t,by,units,kind,x,y,a,bid){
    if(!t.alive)return;
    if(t.inv>0){emit('sd',x,y,a,t.slot,bid);return}
    if(t.fx.shd>0)units=Math.max(1,Math.ceil(units/2));
    t.hp-=units;emit('ht',x,y,a,t.slot,bid);
    if(kind===0&&by&&by.alive&&by.fx.vamp>0&&by.hp<MAXHP){by.hp++;emit('hl',by.x,by.y,0,by.slot)}
    if(t.hp<=0)killTank(t,by,kind);
  }

  /* ---- perks, items, traps ---- */
  function spawnItem(){
    if(items.length>=12)return;const mc=A.mainCells;
    for(let k=0;k<30;k++){
      const c=mc[(Math.random()*mc.length)|0];if(grid[c])continue;
      const x=(c%N+.5)*T,y=(((c/N)|0)+.5)*T;
      if(items.some(i=>Math.hypot(i.x-x,i.y-y)<140))continue;
      items.push({id:nextId++,type:Math.random()<.55?PERKS[(Math.random()*PERKS.length)|0]:TRAPS[(Math.random()*TRAPS.length)|0],x,y});return;
    }
  }
  function applyPerk(t,type){
    const it=ITEMS[type];
    if(type===4){t.fx.lock=it.d;t.lockTgt=null;return}
    if(type===13){emp(t);return}
    if(type>=9){t.fx[it.k]=it.d;return}
    for(const o of tanks)if(o.alive&&o.team===t.team){
      if(type===3){o.fx.regen=it.d;o.regenLeft=4;o.regenT=7.5}else o.fx[it.k]=it.d;
    }
  }
  function emp(t){
    emit('em',t.x,t.y,0,t.slot);
    for(const o of tanks)if(o.alive&&o.team!==t.team&&Math.hypot(o.x-t.x,o.y-t.y)<520)o.fx.jam=3;
    for(let i=traps.length-1;i>=0;i--){const tr=traps[i];if(tr.team===t.team||Math.hypot(tr.x-t.x,tr.y-t.y)>=520)continue;if(ITEMS[tr.type].k==='mine')emit('mb',tr.x,tr.y);traps.splice(i,1)}
  }
  function deployTrap(t){
    const type=t.traps.shift();let x=t.x-Math.cos(t.a)*40,y=t.y-Math.sin(t.a)*40;
    if(solidAt(x,y)){x=t.x;y=t.y}
    const tr={id:nextId++,type,x,y,team:t.team,owner:t.slot,arm:.8,act:0,life:-1,pair:0,a:t.a};
    if(type===17){tr.life=35;t.traps.unshift(26)}   /* wormhole: the exit pad comes next */
    else if(type===26){tr.life=35;for(const o of traps)if(o.type===17&&o.owner===t.slot&&!o.pair){o.pair=tr.id;tr.pair=o.id}}
    else if(type===24)tr.life=25;
    else if(type===25){tr.life=16;tr.hp=2;tr.shots=3;tr.ft=.4}
    traps.push(tr);if(traps.length>24)traps.shift();
    emit('dp',x,y,type,t.slot);
  }
  function triggerTrap(tr,v){
    const k=ITEMS[tr.type].k,owner=tanks[tr.owner];
    emit('tg',tr.x,tr.y,tr.type,v.slot);
    if(k==='mine'){emit('mb',tr.x,tr.y);for(const o of tanks)if(o.alive&&o.team!==tr.team){const d=Math.hypot(o.x-tr.x,o.y-tr.y);if(d<100)dmg(o,owner,3,1,o.x,o.y,0)}}
    else if(k==='slow')v.fx.slow=8;
    else if(k==='poison'){v.fx.poison=8;v.poisonT=1.5}
    else if(k==='smoke')v.fx.smoke=30;
    else if(k==='mimic'){v.fx.root=1;dmg(v,owner,2,1,v.x,v.y,0)}
    else if(k==='tether'){v.fx.teth=5;v.tA={x:tr.x,y:tr.y}}
    else if(k==='shock')v.fx.root=1.5;
    else if(k==='glitchT')v.fx.glitch=4;
    else if(k==='grav'){tr.act=3;return}
    else if(k==='napalm'){tr.act=6;return}
    else if(k==='repulse'){for(const o of tanks){if(!o.alive||o.team===tr.team)continue;const dx=o.x-tr.x,dy=o.y-tr.y,d=Math.hypot(dx,dy);if(d>=140)continue;
      const ux=d>1?dx/d:Math.cos(o.a),uy=d>1?dy/d:Math.sin(o.a);o.kx=ux*1300;o.ky=uy*1300;o.kT=.45;o.kHit=false;o.kBy=tr.owner}}
    else if(k==='decoy'){for(const o of tanks)if(o.alive&&o.team!==tr.team&&Math.hypot(o.x-tr.x,o.y-tr.y)<320)o.fx.flash=3}
    const j=traps.indexOf(tr);if(j>=0)traps.splice(j,1);
  }
  const trapById=id=>{for(const o of traps)if(o.id===id)return o;return null};
  const PORT=[];
  /* traps that keep working after they are placed; returns true when touch-triggering does not apply */
  function trapTick(tr,dt){
    const k=ITEMS[tr.type].k;
    if(k==='portal'||k==='portalb'){const p=tr.pair?trapById(tr.pair):null;if(!p||p.arm>0)return true;
      for(const t of tanks){if(!t.alive||t.ptT>0||Math.hypot(t.x-tr.x,t.y-tr.y)>34)continue;
        emit('po',tr.x,tr.y,0,t.slot);t.x=p.x+Math.cos(t.a)*60;t.y=p.y+Math.sin(t.a)*60;if(solidAt(t.x,t.y)){t.x=p.x;t.y=p.y}collideTank(t);t.ptT=1.2;emit('po',p.x,p.y,1,t.slot)}
      return true}
    if(k==='sentry'){tr.ft-=dt;if(tr.ft>0)return true;const own=tanks[tr.owner];let best=null,bd=650;
      for(const o of tanks){if(!o.alive||o.team===tr.team||o.fx.cloak>0)continue;const d=Math.hypot(o.x-tr.x,o.y-tr.y);if(d<bd&&los(tr,o)){bd=d;best=o}}
      if(!best||!own){tr.ft=.25;return true}
      const an=aimAt(tr,best),c=Math.cos(an),s=Math.sin(an);tr.a=an;
      const b={id:nextBid,x:tr.x+c*26,y:tr.y+s*26,dx:c,dy:s,owner:own,life:.9,dead:false,bn:0,pc:false,lc:-1,hit:null,dm:1,pz:0};
      nextBid=nextBid%9999+1;emit('sp2',b.x,b.y,an,-1,b.id);moveBullet(b,8);if(!b.dead)bullets.push(b);
      tr.ft=1.1;tr.shots--;if(tr.shots<=0)tr.life=.6;return true}
    if(k==='decoy'){for(const o of tanks)if(o.alive&&o.team!==tr.team&&Math.hypot(o.x-tr.x,o.y-tr.y)<140){triggerTrap(tr,o);break}return true}
    if(k==='grav'&&tr.act>0){tr.act-=dt;if(tr.act<=0){tr.life=.01;return true}
      for(const o of tanks){if(!o.alive||o.team===tr.team)continue;const dx=tr.x-o.x,dy=tr.y-o.y,d=Math.hypot(dx,dy);
        if(d<340&&d>8){const p=Math.min(d-8,280*dt*(1.5-d/340));o.x+=dx/d*p;o.y+=dy/d*p;collideTank(o)}}
      return true}
    if(k==='napalm'&&tr.act>0){tr.act-=dt;if(tr.act<=0){tr.life=.01;return true}
      for(const o of tanks)if(o.alive&&o.team!==tr.team&&Math.hypot(o.x-tr.x,o.y-tr.y)<100){if(!(o.fx.burn>0))o.burnT=.25;o.fx.burn=.6;o.burnBy=tr.owner}
      return true}
    return false
  }
  /* bullets break enemy sentries and pop enemy decoys */
  function trapShot(b){
    for(const tr of traps){if(tr.team===b.owner.team||tr.arm>0||(tr.type!==24&&tr.type!==25))continue;
      if(Math.hypot(b.x-tr.x,b.y-tr.y)>26)continue;
      b.dead=true;emit('wl',b.x,b.y,Math.atan2(-b.dy,-b.dx),b.id);
      if(tr.type===24)triggerTrap(tr,b.owner);else if(--tr.hp<=0){emit('mb',tr.x,tr.y);const j=traps.indexOf(tr);if(j>=0)traps.splice(j,1)}
      return true}
    return false
  }
  function lockTarget(t){
    if(t.lockTgt&&t.lockTgt.alive)return t.lockTgt;
    let best=null,bd=1e9;for(const o of tanks){if(!o.alive||o.team===t.team)continue;const d=Math.hypot(o.x-t.x,o.y-t.y);if(d<bd){bd=d;best=o}}
    return t.lockTgt=best;
  }

  /* ---- bullets ---- */
  function hitCrate(k,cx,cy,x,y,a,id){
    chp[k]--;emit('cr',x,y,a,id);
    if(chp[k]<=0){grid[k]=0;broken.push({x:cx,y:cy,t:25});emit('cb',(cx+.5)*T,(cy+.5)*T)}
    crD.push(k);
  }
  function moveBullet(b,dist){
    const n=Math.ceil(dist/8),sd=dist/n;
    for(let i=0;i<n;i++){
      b.x+=b.dx*sd;b.y+=b.dy*sd;
      const cx=Math.floor(b.x/T),cy=Math.floor(b.y/T),g=inb(cx,cy)?grid[idx(cx,cy)]:1;
      if(g){const a=Math.atan2(-b.dy,-b.dx),k=g===2?idx(cx,cy):-1;
        if(g===2&&b.pc){if(b.lc!==k){b.lc=k;hitCrate(k,cx,cy,b.x,b.y,a,-1)}continue}   /* railgun cuts through crates */
        if(b.bn>0){const px=b.x-b.dx*sd,py=b.y-b.dy*sd,fx=Math.floor(px/T)!==cx,fy=Math.floor(py/T)!==cy;   /* ricochet */
          if(g===2)hitCrate(k,cx,cy,b.x,b.y,a,-1);else emit('wl',b.x,b.y,a,-1);
          if(fx||!fy)b.dx=-b.dx;if(fy||!fx)b.dy=-b.dy;b.x=px;b.y=py;b.bn--;continue}
        b.dead=true;
        if(g===1)emit('wl',b.x,b.y,a,b.id);else hitCrate(k,cx,cy,b.x,b.y,a,b.id);
        return}
      if(b.pz>0)b.pz-=sd;else for(let q=0;q<PORT.length;q++){const tr=PORT[q];if(Math.hypot(b.x-tr.x,b.y-tr.y)>26)continue;
        const p=trapById(tr.pair);if(!p)continue;b.x=p.x+b.dx*30;b.y=p.dy?p.y+b.dy*30:p.y+b.dy*30;b.pz=90;emit('pb',b.x,b.y,Math.atan2(b.dy,b.dx),-1,b.id);break}   /* wormhole */
      if(traps.length&&trapShot(b))return;
      for(const t of tanks){
        if(!t.alive||t===b.owner||t.team===b.owner.team)continue;
        const rx=b.x-t.x,ry=b.y-t.y,c=Math.cos(t.a),s=Math.sin(t.a),lx=rx*c+ry*s,ly=-rx*s+ry*c;
        if(Math.abs(lx)<33&&Math.abs(ly)<26){
          if(b.pc){if(b.hit.indexOf(t.slot)<0){b.hit.push(t.slot);dmg(t,b.owner,BDMG,0,b.x,b.y,Math.atan2(-b.dy,-b.dx),-1)}continue}   /* railgun pierces tanks */
          b.dead=true;dmg(t,b.owner,b.dm||BDMG,0,b.x,b.y,Math.atan2(-b.dy,-b.dx),b.id);return}
      }
    }
  }
  function fire(t){
    const n=t.fx.spread>0?3:1,pc=t.fx.pierce>0;
    for(let j=0;j<n;j++){
      const an=t.ta+(n===3?(j-1)*.18:0),c=Math.cos(an),s=Math.sin(an);
      const b={id:nextBid,x:t.x+c*14,y:t.y+s*14,dx:c,dy:s,owner:t,life:1.1,dead:false,bn:t.fx.bounce>0?2:0,pc,lc:-1,hit:pc?[]:null,pz:0};
      nextBid=nextBid%9999+1;
      emit('sp2',t.x+c*48,t.y+s*48,an,t.slot,b.id);   // shot event first: the client spawns its bullet from it
      moveBullet(b,34);if(!b.dead)bullets.push(b);
    }
    t.cd=RELOAD*(t.fx.rate>0?.5:1)*(n===3?1.5:1);
  }
  function stepTank(t,dt,live){
    if(!t.alive){if(live){t.respawnT-=dt;if(t.respawnT<=0)respawn(t)}return}
    for(const k of FXK)if(t.fx[k]>0)t.fx[k]=Math.max(0,t.fx[k]-dt);
    t.inv=Math.max(0,t.inv-dt);t.cd-=dt;
    const i=t.inp;
    if(!live){i.thrust=i.turn=0;i.vec=false;i.mag=0;i.fire=false}
    if(t.fx.lock>0){const g=lockTarget(t);if(g)i.aim=aimAt(t,g)}
    if(t.ptT>0)t.ptT-=dt;
    if(t.kT>0){t.kT-=dt;const px=t.x,py=t.y,ex=t.kx*dt,ey=t.ky*dt;t.x+=ex;t.y+=ey;collideTank(t);t.kx*=Math.exp(-dt*3);t.ky*=Math.exp(-dt*3);   /* repulsor knockback */
      if(!t.kHit&&Math.hypot(ex,ey)>8&&Math.hypot(t.x-px,t.y-py)<Math.hypot(ex,ey)*.5){t.kHit=true;t.kT=0;emit('mb',t.x,t.y);dmg(t,tanks[t.kBy],2,1,t.x,t.y,0);if(!t.alive)return}}
    if(t.fx.teth>0&&t.tA){if(Math.hypot(t.x-t.tA.x,t.y-t.tA.y)>170){emit('ty',t.x,t.y,0,t.slot);t.x=t.tA.x;t.y=t.tA.y;t.v=0;collideTank(t);t.fx.teth=0;t.tA=null;t.fx.root=.5;emit('ty',t.x,t.y,1,t.slot)}}else t.tA=null;
    if(t.fx.burn>0){t.burnT-=dt;if(t.burnT<=0){t.burnT=1;dmg(t,tanks[t.burnBy],1,1,t.x,t.y,0);if(!t.alive)return}}
    moveTank(t,dt,fxMul(t));
    if(live&&i.fire&&t.cd<=0&&!(t.fx.jam>0))fire(t);
    if(t.fx.regen>0){t.regenT-=dt;if(t.regenT<=0){t.regenT=7.5;if(t.regenLeft>0&&t.hp<MAXHP){t.hp++;t.regenLeft--;emit('hl',t.x,t.y,0,t.slot)}}}
    if(t.fx.poison>0){t.poisonT-=dt;if(t.poisonT<=0){t.poisonT=2;if(t.hp>1){t.hp--;emit('ht',t.x,t.y,0,t.slot)}}}
    if(i.dp!==t.dpSeen){t.dpSeen=i.dp;if(live&&t.traps.length)deployTrap(t)}
  }

  /* ---- bot AI ---- */
  function newBrain(){return{think:Math.random()*.3,target:null,react:0,err:0,sloppy:rnd(.1,.3),strafe:Math.random()<.5?1:-1,side:Math.random()<.5?1:-1,wp:null,wpT:0,sx:0,sy:0,st:0,dpT:rnd(1,4)}}
  function los(a,b){const dx=b.x-a.x,dy=b.y-a.y,n=Math.ceil(Math.hypot(dx,dy)/24);for(let i=1;i<n;i++)if(solidAt(a.x+dx*i/n,a.y+dy*i/n))return false;return true}
  const OFFS=[0,-24,24],TURNS=[.6,-.6,1.2,-1.2,1.9,-1.9];
  function blocked(t,ang,len){const c=Math.cos(ang),s=Math.sin(ang);
    for(let q=0;q<3;q++){const off=OFFS[q],ox=t.x-s*off,oy=t.y+c*off;for(let d=24;d<=len;d+=20){const g=solidAt(ox+c*d,oy+s*d);if(g){rayG=g;return true}}}rayG=0;return false}
  function ai(t,dt){
    const B=t.brain,i=t.inp;i.vec=true;i.fire=false;B.think-=dt;B.react-=dt;B.dpT-=dt;
    if(B.think<=0){
      B.think=.25+Math.random()*.2;B.err=(Math.random()-.5)*B.sloppy;let best=null,bd=1e9;
      for(const o of tanks){if(o===t||!o.alive||o.team===t.team)continue;const d=Math.hypot(o.x-t.x,o.y-t.y);if(o.fx.cloak>0&&d>320)continue;if(d<bd&&d<950&&los(t,o)){best=o;bd=d}}
      if(best&&best!==B.target)B.react=rnd(.25,.6);B.target=best;
    }
    if(t.traps.length&&B.dpT<=0&&Math.random()<.03){i.dp++;B.dpT=rnd(3,7)}
    const tg=B.target&&B.target.alive?B.target:null;let want=t.a,mag=.85;
    if(tg){
      const dx=tg.x-t.x,dy=tg.y-t.y,d=Math.hypot(dx,dy),aim=aimAt(t,tg)+B.err;i.aim=aim;
      if(Math.abs(angDiff(t.ta,aim))<.09&&d<850&&B.react<=0&&los(t,tg))i.fire=true;
      const ang=Math.atan2(dy,dx);want=d>480?ang+B.strafe*.4:d<260?ang+Math.PI-B.strafe*.5:ang+B.strafe*1.4;mag=1;
    }else{
      if(!B.wp||B.wpT<=0||Math.hypot(B.wp.x-t.x,B.wp.y-t.y)<90){
        let it=null,bd=700;if(items.length&&Math.random()<.6)for(const o of items){const d=Math.hypot(o.x-t.x,o.y-t.y);if(d<bd){bd=d;it=o}}
        if(it)B.wp={x:it.x,y:it.y};else{const mc=A.mainCells,c=mc[(Math.random()*mc.length)|0];B.wp={x:(c%N+.5)*T,y:(((c/N)|0)+.5)*T}}
        B.wpT=8+Math.random()*6;
      }
      B.wpT-=dt;want=Math.atan2(B.wp.y-t.y,B.wp.x-t.x);i.aim=want;
    }
    if(blocked(t,want,120)){
      if(!tg&&rayG===2){i.aim=want;if(Math.abs(angDiff(t.ta,want))<.1)i.fire=true}
      let found=false;for(let q=0;q<TURNS.length;q++){const a=want+TURNS[q]*B.side;if(!blocked(t,a,120)){want=a;found=true;break}}
      if(!found)want+=Math.PI;
    }
    B.st+=dt;if(B.st>1){if(Math.hypot(t.x-B.sx,t.y-B.sy)<25){B.wp=null;B.side*=-1;B.strafe*=-1}B.sx=t.x;B.sy=t.y;B.st=0}
    i.vx=Math.cos(want);i.vy=Math.sin(want);i.mag=mag;
  }

  /* ---- match flow ---- */
  function startMatch(){
    ROOM.slots=ROOM.slots.filter(s=>!s.left);
    const seed=(Math.random()*1e9)|0;
    ev.length=0;crD.length=0;
    A.genMap(seed);G.seed=seed;G.mid++;tanks.length=0;bullets.length=0;items.length=0;traps.length=0;broken.length=0;
    ROOM.slots.forEach((s,i)=>{s.rm=0;const t=makeTank(i,s.name,teamOf(i),!!s.bot,s.id);if(s.bot)t.brain=newBrain();tanks.push(t)});
    tanks.forEach(t=>respawn(t,true));
    G.ph=1;G.cd=3.5;G.tl=MATCH_T;G.itemT=1;for(let i=0;i<8;i++)spawnItem();
    startDirty=phDirty=lobbyDirty=true;
  }
  function toLobby(){
    ROOM.slots=ROOM.slots.filter(s=>!s.left);ROOM.slots.forEach(s=>{s.rm=0});
    G.ph=0;tanks.length=0;bullets.length=0;items.length=0;traps.length=0;broken.length=0;ev.length=0;crD.length=0;
    phDirty=lobbyDirty=true;
  }
  function simStep(dt){
    stepN++;
    if(G.ph===0||G.ph===3)return;
    const live=G.ph===2;
    if(G.ph===1){G.cd-=dt;if(G.cd<=0){G.ph=2;phDirty=true}}
    else{G.tl-=dt;if(G.tl<=0){G.tl=0;G.ph=3;phDirty=lobbyDirty=true;bullets.length=0;return}G.itemT-=dt;if(G.itemT<=0){spawnItem();G.itemT=5}}
    for(const t of tanks){
      if(!t.bot&&t.cid){const c=clients.get(t.cid);if(c){const s=c.inp,i=t.inp;i.thrust=s.thrust;i.turn=s.turn;i.vec=s.vec;i.vx=s.vx;i.vy=s.vy;i.mag=s.mag;i.aim=s.aim;i.fire=s.fire;i.dp=s.dp}}
      if(live&&t.bot&&t.alive)ai(t,dt);
      stepTank(t,dt,live);
    }
    for(let a=0;a<tanks.length;a++)for(let b=a+1;b<tanks.length;b++){
      const p=tanks[a],q=tanks[b];if(!p.alive||!q.alive)continue;
      const dx=q.x-p.x,dy=q.y-p.y,d=Math.hypot(dx,dy),m=TANK_R*1.8;
      if(d<m&&d>.001){const k=(m-d)/2/d;p.x-=dx*k;p.y-=dy*k;q.x+=dx*k;q.y+=dy*k;collideTank(p);collideTank(q)}
    }
    PORT.length=0;for(const tr of traps)if((tr.type===17||tr.type===26)&&tr.pair&&tr.arm<=0){const p=trapById(tr.pair);if(p&&p.arm<=0)PORT.push(tr)}
    for(let i=bullets.length-1;i>=0;i--){const b=bullets[i];b.life-=dt;moveBullet(b,BSPD*dt);if(b.dead||b.life<=0){bullets[i]=bullets[bullets.length-1];bullets.pop()}}
    if(live){
      for(let i=items.length-1;i>=0;i--){const it=items[i];
        for(const t of tanks){if(!t.alive||Math.hypot(t.x-it.x,t.y-it.y)>40)continue;
          if(isPerk(it.type))applyPerk(t,it.type);else if(t.traps.length<3)t.traps.push(it.type);else continue;
          emit('pk',it.x,it.y,it.type,t.slot);items.splice(i,1);break}}
      for(let i=traps.length-1;i>=0;i--){const tr=traps[i];if(!tr)continue;tr.arm-=dt;if(tr.arm>0)continue;
        if(tr.life>0){tr.life-=dt;if(tr.life<=0){traps.splice(i,1);continue}}
        if(trapTick(tr,dt))continue;
        for(const t of tanks){if(!t.alive||t.team===tr.team)continue;if(Math.hypot(t.x-tr.x,t.y-tr.y)<36){triggerTrap(tr,t);break}}}
    }
    for(let i=broken.length-1;i>=0;i--){const c=broken[i];c.t-=dt;if(c.t>0)continue;
      const cx=(c.x+.5)*T,cy=(c.y+.5)*T;let free=true;
      for(const t of tanks)if(t.alive&&Math.abs(t.x-cx)<T/2+TANK_R+10&&Math.abs(t.y-cy)<T/2+TANK_R+10)free=false;
      if(free){A.setCell(c.x,c.y,2);crD.push(idx(c.x,c.y));emit('rs',cx,cy);broken.splice(i,1)}else c.t=2}
  }

  /* ---- lobby ---- */
  function teamCount(t){let n=0;for(const s of ROOM.slots)if(s.team===t&&!s.left)n++;return n}
  function nextTeam(){if(!md().teams)return 0;return teamCount(0)<=teamCount(1)?0:1}
  function uniqueName(n){const b=n;let k=1;while(ROOM.slots.some(s=>s.name===n&&!s.left))n=b.slice(0,8)+(++k);return n}
  function addBot(){
    if(G.ph!==0||ROOM.slots.length>=cap())return;
    const used={};ROOM.slots.forEach(s=>{used[s.name]=1});
    let nm='BOT'+ROOM.slots.length;for(let i=0;i<BOTNAMES.length;i++)if(!used[BOTNAMES[i]]){nm=BOTNAMES[i];break}
    ROOM.slots.push({id:'',bot:true,name:nm,team:nextTeam(),rm:0,left:false});lobbyDirty=true;
  }
  function removeSlot(cid,i){
    const s=ROOM.slots[i];if(!s||G.ph!==0||s.id===cid)return;
    if(!s.bot&&s.id){io.kick(s.id,4012,'kicked');return}
    ROOM.slots.splice(i,1);lobbyDirty=true;
  }
  function setMode(cid,m){
    if(G.ph!==0||!(m>=0&&m<MODES.length)||m===ROOM.mode)return;
    const n=MODES[m].n;
    if(humans().length>n){say(cid,'Too many players for '+MODES[m].k+' (max '+n+')');return}
    while(ROOM.slots.length>n){let bi=-1;for(let i=ROOM.slots.length-1;i>=0;i--)if(ROOM.slots[i].bot){bi=i;break}if(bi<0)break;ROOM.slots.splice(bi,1)}
    ROOM.mode=m;
    if(MODES[m].teams)ROOM.slots.forEach((s,i)=>{s.team=i%2});
    lobbyDirty=true;
  }
  function switchTeam(cid,i){
    const s=ROOM.slots[i];if(!s||G.ph!==0||!md().teams)return;
    if(cid!==ROOM.owner&&s.id!==cid)return;
    const to=1-s.team;if(teamCount(to)>=cap()/2){say(cid,'That team is full');return}
    s.team=to;lobbyDirty=true;
  }
  function canStart(){
    if(md().teams)return teamCount(0)<1||teamCount(1)<1?'Each team needs at least one tank (add a bot)':'';
    return ROOM.slots.length<2?'Free-for-all needs 2 to 8 tanks (add a bot)':'';
  }
  function checkRematch(){if(G.ph!==3)return;const hs=humans();if(hs.length&&hs.every(s=>s.rm===1))startMatch()}
  function vote(cid,v){
    if(G.ph!==3)return;const i=slotOf(cid);if(i<0)return;
    if(v===2&&cid===ROOM.owner){toLobby();return}
    ROOM.slots[i].rm=v===1?1:2;lobbyDirty=true;checkRematch();
  }
  function parseInput(n,b){
    const a=b.split(',');if(a.length<6)return;
    if(a[0]==='1'){n.vec=true;const x=clamp(num(a[1]),-100,100)/100,y=clamp(num(a[2]),-100,100)/100,m=Math.min(1,Math.hypot(x,y));n.mag=m;if(m>0){n.vx=x/m;n.vy=y/m}}
    else{n.vec=false;n.thrust=clamp(num(a[1]),-1,1);n.turn=clamp(num(a[2]),-1,1)}
    n.aim=num(a[3])/1000;n.fire=a[4]==='1';n.dp=num(a[5])|0;
  }

  /* ---- encoding ---- */
  function lobbyStr(){
    const rq=[],rr=[];
    ROOM.slots.forEach((s,i)=>{if(s.bot||s.left)return;if(s.rm===1)rq.push(i);else if(s.rm===2)rr.push(i)});
    return 'L|'+ROOM.mode+'|'+ROOM.owner+'|'+rq.join('.')+'|'+rr.join('.')+'|'+
      ROOM.slots.map(s=>s.name+','+(s.team|0)+','+(s.bot?1:0)+','+(s.id||'')+','+(s.left?1:0)).join(';');
  }
  function flush(){
    const out=[];
    if(lobbyDirty){lobbyDirty=false;out.push(lobbyStr())}
    if(startDirty){startDirty=false;out.push('M|'+G.mid+'|'+G.seed+'|'+ROOM.mode,'C|'+A.crateStr());crD.length=0;lastS=lastI=lastX='';lastRow.length=0}
    const inM=G.ph===1||G.ph===2;
    if(phDirty||(inM&&tickN%20===0)){phDirty=false;out.push('P|'+G.ph+'|'+R(G.tl*10)+'|'+R(Math.max(0,G.cd)*10))}
    if(G.ph>0){
      if(crD.length){const seen={};let s='';
        for(let q=0;q<crD.length;q++){const k=crD[q];if(seen[k])continue;seen[k]=1;const ci=A.crateOf[k];if(ci<0)continue;s+=(s?';':'')+ci+','+(grid[k]===2?chp[k]:0)}
        crD.length=0;if(s)out.push('c|'+s)}
      let s='S|';
      for(let i=0;i<tanks.length;i++){const t=tanks[i],lk=t.lockTgt&&t.fx.lock>0&&t.lockTgt.alive?t.lockTgt.slot+1:0;s+=(i?';':'')+t.kills+','+t.deaths+','+lk+','+t.traps.map(v=>v.toString(36)).join('')}
      if(s!==lastS){lastS=s;out.push(s)}
      s='I|'+items.map(i=>i.id+','+i.type+','+R(i.x)+','+R(i.y)).join(';');
      if(s!==lastI){lastI=s;out.push(s)}
      s='X|'+traps.map(t=>t.id+','+t.type+','+R(t.x)+','+R(t.y)+','+t.team+','+(t.arm>0?0:t.act>0?2:1)+','+t.owner+','+na(t.a)).join(';');
      if(s!==lastX){lastX=s;out.push(s)}
      if(inM){
        const key=tickN%40===0;let u='u|'+stepN;
        for(let i=0;i<tanks.length;i++){const t=tanks[i];if(!t.alive){lastRow[i]='';continue}
          const row=R(t.x)+','+R(t.y)+','+na(t.a)+','+na(t.ta)+','+R(t.v)+','+t.hp+','+flagsOf(t);
          u+='|'+i;if(key||row!==lastRow[i]){u+=','+row;lastRow[i]=row}}
        out.push(u);
      }
      if(ev.length){out.push('e|'+ev.join(';'));ev.length=0}
    }else ev.length=0;
    if(out.length)io.all(out.join('\n'));
  }

  /* ---- public API ---- */
  function reset(){
    ROOM.mode=1;ROOM.slots=[];ROOM.owner='';G.ph=0;G.tl=MATCH_T;G.cd=0;
    tanks.length=0;bullets.length=0;items.length=0;traps.length=0;broken.length=0;ev.length=0;crD.length=0;lastRow.length=0;
    acc=0;lastMs=0;lobbyDirty=phDirty=true;startDirty=false;lastS=lastI=lastX='';
  }
  function canJoin(isNew){
    if(isNew)return clients.size?{code:4009,r:'taken'}:null;
    if(!clients.size)return{code:4004,r:'noroom'};
    if(G.ph!==0)return{code:4011,r:'busy'};
    if(humans().length>=cap())return{code:4010,r:'full'};
    return null;
  }
  function join(cid,name){
    if(!clients.size)reset();
    clients.set(cid,{inp:newInp()});
    if(ROOM.slots.length>=cap()){for(let i=ROOM.slots.length-1;i>=0;i--)if(ROOM.slots[i].bot){ROOM.slots.splice(i,1);break}}
    ROOM.slots.push({id:cid,bot:false,name:uniqueName(cleanName(name)),team:nextTeam(),rm:0,left:false});
    if(!ROOM.owner||!clients.has(ROOM.owner))ROOM.owner=cid;
    io.to(cid,'w|'+cid);
    lobbyDirty=phDirty=true;
  }
  function leave(cid){
    if(!clients.delete(cid))return;
    const i=slotOf(cid);
    if(i>=0){const s=ROOM.slots[i];
      if(G.ph===0)ROOM.slots.splice(i,1);
      else if(G.ph===3){s.left=true;s.id='';if(tanks[i])tanks[i].cid=null}
      else{s.bot=true;s.id='';const t=tanks[i];if(t){t.bot=true;t.cid=null;t.brain=newBrain()}}
    }
    if(cid===ROOM.owner){ROOM.owner='';for(const s of ROOM.slots)if(!s.bot&&!s.left&&s.id&&clients.has(s.id)){ROOM.owner=s.id;break}}
    if(!clients.size){reset();return}
    lobbyDirty=true;checkRematch();
  }
  function onMsg(cid,msg){
    if(typeof msg!=='string'||!msg||msg.length>160)return;
    const c=clients.get(cid);if(!c)return;
    const k=msg[0],body=msg.length>2?msg.slice(2):'';
    if(k==='p'){io.to(cid,'o|'+body.slice(0,20));return}
    if(k==='i'){parseInput(c.inp,body);return}
    const own=cid===ROOM.owner,n=body===''?-1:(num(body,-1)|0);
    if(k==='m'){if(own)setMode(cid,n)}
    else if(k==='b'){if(own)addBot()}
    else if(k==='r'){if(own)removeSlot(cid,n)}
    else if(k==='t')switchTeam(cid,n);
    else if(k==='s'){if(own&&G.ph===0){const why=canStart();if(why)say(cid,why);else startMatch()}}
    else if(k==='v')vote(cid,n);
    else if(k==='q')emote(cid,c,n);
  }
  /* q|n quick comms: relayed only to the sender's own team (never in free for all) */
  function emote(cid,c,n){
    if(!(G.ph===1||G.ph===2)||!md().teams||n<0||n>5)return;
    if(c.qT&&tickN-c.qT<16)return;c.qT=tickN||1;
    const i=slotOf(cid);if(i<0)return;const tm=ROOM.slots[i].team,m='q|'+i+'|'+n;
    clients.forEach((v,id)=>{const j=slotOf(id);if(j>=0&&ROOM.slots[j].team===tm)io.to(id,m)});
  }
  function tick(now){
    if(!lastMs)lastMs=now;let dt=(now-lastMs)/1000;lastMs=now;if(!(dt>0))dt=0;if(dt>.25)dt=.25;
    acc+=dt;let n=0;while(acc>=STEP&&n<15){simStep(STEP);acc-=STEP;n++}
    tickN++;flush();
  }
  return{canJoin,join,leave,onMsg,tick,size:()=>clients.size};
}

/* ============ STANDALONE SERVER (Node.js): same Engine, hosted in India / Singapore for low ping ============
   Run:  npm install  &&  node server.js        (PORT env var, default 8080)
   Players connect to  ws(s)://this-server/r/CODE  exactly like the Cloudflare worker.
   If index.html sits next to this file, opening this server's address in a browser plays the game on THIS server. */
var http = require("http");
var fs = require("fs");
var path = require("path");
var WebSocketServer = require("ws").WebSocketServer;

var PORT = parseInt(process.env.PORT || "8080", 10);
var IDLE_MS = 15000;     // a socket silent this long is dropped (clients ping every 2 s)
var EMPTY_MS = 30000;    // an empty room is deleted after this long
var rooms = new Map();   // code -> room

function makeRoom(code) {
  var room = { code: code, socks: new Map(), seen: new Map(), timer: null, ticks: 0, emptyAt: 0, eng: null };
  function send(id, s) {
    var ws = room.socks.get(id);
    if (!ws || ws.readyState !== 1) return;
    if (ws.bufferedAmount > 65536) return;   // a stalled phone must not grow server memory; the next tick resends state
    try { ws.send(s); } catch (e) { drop(id); }
  }
  function drop(id) {
    if (!room.socks.has(id)) return;
    room.socks.delete(id);
    room.seen.delete(id);
    room.eng.leave(id);
    if (room.socks.size === 0) { stop(); room.emptyAt = Date.now(); }
  }
  function stop() { if (room.timer !== null) { clearInterval(room.timer); room.timer = null; } }
  function loop() {
    var now = Date.now();
    room.eng.tick(now);
    if (++room.ticks % 20 === 0) {
      var stale = [];
      room.seen.forEach(function (t, id) { if (now - t > IDLE_MS) stale.push(id); });
      for (var i = 0; i < stale.length; i++) {
        var ws = room.socks.get(stale[i]);
        if (ws) { try { ws.close(4008, "idle"); } catch (e) {} }
        drop(stale[i]);
      }
    }
  }
  room.send = send;
  room.drop = drop;
  room.start = function () { if (room.timer === null) room.timer = setInterval(loop, 50); };
  room.eng = Engine({
    all: function (s) { room.socks.forEach(function (ws, id) { send(id, s); }); },
    to: function (id, s) { send(id, s); },
    kick: function (id, code, reason) {
      var ws = room.socks.get(id);
      if (ws) { try { ws.close(code, reason); } catch (e) {} }
      drop(id);
    }
  });
  return room;
}

function newId(room) {
  var id = "";
  do { id = Math.random().toString(36).slice(2, 6); } while (id.length < 4 || room.socks.has(id));
  return id;
}

/* The game page: served with its server address pointed back at this machine. */
var page = null;
try {
  page = fs.readFileSync(path.join(__dirname, "index.html"), "utf8")
    .replace(/const DEFAULT_SERVER='[^']*';/, "const DEFAULT_SERVER=(location.protocol==='https:'?'wss://':'ws://')+location.host;");
} catch (e) { page = null; }

var server = http.createServer(function (req, res) {
  var p = (req.url || "/").split("?")[0];
  if (page && (p === "/" || p === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(page);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Tank Arena server OK - rooms: " + rooms.size);
});

var wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 512 });

server.on("upgrade", function (req, socket, head) {
  var u = new URL(req.url || "/", "http://x");
  var m = u.pathname.match(/^\/r\/([A-Za-z0-9]{5})$/);
  if (!m) { socket.destroy(); return; }
  try { socket.setNoDelay(true); } catch (e) {}
  wss.handleUpgrade(req, socket, head, function (ws) {
    var code = m[1].toUpperCase();
    var isNew = u.searchParams.get("new") === "1";
    var name = cleanName(u.searchParams.get("n"));
    var room = rooms.get(code);
    if (!room) { room = makeRoom(code); rooms.set(code, room); room.emptyAt = Date.now(); }
    var why = room.eng.canJoin(isNew);
    if (why) { try { ws.close(why.code, why.r); } catch (e) {} return; }
    var id = newId(room);
    room.socks.set(id, ws);
    room.seen.set(id, Date.now());
    room.emptyAt = 0;
    ws.on("message", function (data, isBinary) {
      if (isBinary) return;
      var d = data.toString();
      if (d.length === 0 || d.length > 160) return;
      room.seen.set(id, Date.now());
      if (d.charCodeAt(0) === 112 && d.charCodeAt(1) === 124) {   // "p|ts": answer the ping right away
        try { ws.send("o|" + d.slice(2, 22)); } catch (x) {}
        return;
      }
      room.eng.onMsg(id, d);
    });
    ws.on("close", function () { room.drop(id); });
    ws.on("error", function () { room.drop(id); });
    room.eng.join(id, name);
    room.start();
  });
});

/* Delete rooms nobody has used for a while. */
setInterval(function () {
  var now = Date.now(), dead = [];
  rooms.forEach(function (r, code) { if (r.socks.size === 0 && r.emptyAt && now - r.emptyAt > EMPTY_MS) dead.push(code); });
  for (var i = 0; i < dead.length; i++) rooms.delete(dead[i]);
}, 10000);

server.listen(PORT, "0.0.0.0", function () {
  console.log("Tank Arena server listening on port " + PORT + (page ? " (serving the game page too)" : ""));
});
