// Rendering source: jiulinjc.xyz, Memory Constellation 3D. See NOTICE.txt.
// The caller supplies Echo nodes and typed edges; the scene does not fetch data.
export function createConstellation(THREE, el, onSelect) {
  const LAYOUT = [
    {id:"identity",     name:"自我", en:"IDENTITY",     color:0xd8b56e, center:[0, 2.00, 0.35],  rot:[0.10, 0.15, 0.02], spread:.48, depth:.34, labelY:.65, blurb:"价值观 / 边界 / 身份锚点"},
    {id:"relationship", name:"关系", en:"RELATIONSHIP", color:0xd49a9f, center:[2.35, 0.85, 0.90], rot:[0.02,-0.55, 0.10], spread:.62, depth:.42, labelY:.66, blurb:"人物 / 信任 / 依恋 / 张力"},
    {id:"episodic",     name:"情节", en:"EPISODIC",     color:0x8cb9c9, center:[2.45,-0.45,-0.75],rot:[-0.10,-0.95, 0.04],spread:.68, depth:.45, labelY:.70, blurb:"事件 / 场景 / 对话"},
    {id:"semantic",     name:"语义", en:"SEMANTIC",     color:0xa99dcc, center:[1.05,-1.70, 1.35], rot:[0.16,-0.35, 0.12], spread:.64, depth:.40, labelY:.66, blurb:"事实 / 偏好 / 模式"},
    {id:"task",         name:"任务", en:"TASK",         color:0x8fbfa9, center:[-1.35,-1.35,1.35],rot:[0.15, 0.55,-0.06], spread:.64, depth:.40, labelY:.66, blurb:"项目 / 承诺 / 待办"},
    {id:"procedural",   name:"程序", en:"PROCEDURAL",   color:0xc5a878, center:[-2.45,0.05,-0.20],rot:[0.00, 1.15, 0.05], spread:.56, depth:.36, labelY:.62, blurb:"技能 / 流程 / 怎么做"},
    {id:"inner",        name:"内隐", en:"INNER",        color:0x9aa3ae, center:[-0.55,0.20,-1.65],rot:[-0.12,-0.20, 0.15],spread:.42, depth:.34, labelY:.58, blurb:"思考 / 反思 / 想象"}
  ];

  const PATTERNS = {
    identity:      [[0,-1],[.70,-.40],[.45,.55],[-.45,.55],[-.70,-.40]],
    relationship:  [[-.86,-.16],[-.34,-.82],[.55,-.66],[.82,.22],[.00,.86]],
    episodic:      [[-.90,.12],[-.46,-.74],[.50,-.80],[.86,.00],[.20,.82]],
    semantic:      [[-.76,-.54],[.10,-.94],[.82,-.34],[.55,.60],[-.40,.70]],
    task:          [[-.82,-.44],[.00,-.95],[.82,-.44],[.55,.56],[-.52,.60]],
    procedural:    [[-.82,-.66],[.20,-.84],[.86,-.14],[.36,.70],[-.56,.56]],
    inner:         [[0,-.84],[.76,-.26],[.50,.66],[-.50,.66],[-.76,-.26]]
  };

  function mulberry32(a){
    return function(){
      a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a);
      t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296;
    };
  }
  const rand=mulberry32(20261029);

  let CLASSES=[], NODES=[], externalEdges=[];
  const state={selected:null,hover:null};
  let motion=!matchMedia("(prefers-reduced-motion: reduce)").matches;
  let cameraGoal=null;

  // ---------- renderer ----------
  let renderer;
  try{
    renderer=new THREE.WebGLRenderer({canvas:el.canvas,antialias:true,alpha:true,powerPreference:"high-performance"});
  }catch(err){
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
  renderer.setSize(window.innerWidth,window.innerHeight);
  renderer.setClearColor(0x000000,0);

  const scene=new THREE.Scene();
  scene.fog=new THREE.FogExp2(0x03050a,0.018);
  const camera=new THREE.PerspectiveCamera(42,window.innerWidth/window.innerHeight,.1,90);
  camera.position.set(3.4,2.4,7.4);

  const controls=new THREE.OrbitControls(camera,renderer.domElement);
  controls.target.set(0,0,0);
  controls.enableDamping=true;
  controls.dampingFactor=.055;
  controls.enablePan=true;
  controls.autoRotate=true;
  controls.autoRotateSpeed=.26;
  controls.minDistance=4.2;
  controls.maxDistance=12.5;
  controls.minPolarAngle=.52;
  controls.maxPolarAngle=2.45;
  controls.rotateSpeed=.55;
  controls.zoomSpeed=.65;

  const reduce=matchMedia("(prefers-reduced-motion: reduce)").matches;
  if(reduce) controls.autoRotate=false;
  let autoResume=0;
  controls.addEventListener("start",()=>{controls.autoRotate=false;cameraGoal=null;});
  controls.addEventListener("end",()=>{autoResume=performance.now()+6000;});

  // ---------- textures ----------
  function glowTexture(){
    const c=document.createElement("canvas"); c.width=c.height=128;
    const ctx=c.getContext("2d");
    const g=ctx.createRadialGradient(64,64,0,64,64,64);
    g.addColorStop(0,"rgba(255,255,255,1)");
    g.addColorStop(.10,"rgba(255,255,255,.96)");
    g.addColorStop(.22,"rgba(255,255,255,.58)");
    g.addColorStop(.46,"rgba(255,255,255,.15)");
    g.addColorStop(1,"rgba(255,255,255,0)");
    ctx.fillStyle=g; ctx.beginPath(); ctx.arc(64,64,64,0,Math.PI*2); ctx.fill();
    return new THREE.CanvasTexture(c);
  }
  function ringTexture(){
    const c=document.createElement("canvas"); c.width=c.height=128;
    const ctx=c.getContext("2d");
    ctx.strokeStyle="rgba(255,255,255,.9)"; ctx.lineWidth=1.6;
    ctx.beginPath(); ctx.arc(64,64,42,0,Math.PI*2); ctx.stroke();
    ctx.strokeStyle="rgba(255,255,255,.25)"; ctx.lineWidth=.7;
    ctx.beginPath(); ctx.arc(64,64,50,0,Math.PI*2); ctx.stroke();
    return new THREE.CanvasTexture(c);
  }
  function nebulaTexture(){
    const c=document.createElement("canvas"); c.width=c.height=256;
    const ctx=c.getContext("2d");
    const g=ctx.createRadialGradient(128,128,0,128,128,128);
    g.addColorStop(0,"rgba(255,255,255,.22)");
    g.addColorStop(.28,"rgba(255,255,255,.10)");
    g.addColorStop(.62,"rgba(255,255,255,.025)");
    g.addColorStop(1,"rgba(255,255,255,0)");
    ctx.fillStyle=g; ctx.fillRect(0,0,256,256);
    return new THREE.CanvasTexture(c);
  }
  const TEX={glow:glowTexture(),ring:ringTexture(),nebula:nebulaTexture()};

  // ---------- background ----------
  (function background(){
    const count=2600, pos=new Float32Array(count*3), col=new Float32Array(count*3);
    const pal=[new THREE.Color(0xdfe5ef),new THREE.Color(0x9fb8d8),new THREE.Color(0xd8b56e),new THREE.Color(0xb58fa8)];
    for(let i=0;i<count;i++){
      const r=16+Math.random()*34, th=Math.random()*Math.PI*2, ph=Math.acos(2*Math.random()-1);
      pos[i*3]=Math.sin(ph)*Math.cos(th)*r;
      pos[i*3+1]=Math.cos(ph)*r*.75;
      pos[i*3+2]=Math.sin(ph)*Math.sin(th)*r;
      const c=pal[Math.floor(Math.random()*pal.length)];
      const dim=.35+Math.random()*.65;
      col[i*3]=c.r*dim; col[i*3+1]=c.g*dim; col[i*3+2]=c.b*dim;
    }
    const geo=new THREE.BufferGeometry();
    geo.setAttribute("position",new THREE.BufferAttribute(pos,3));
    geo.setAttribute("color",new THREE.BufferAttribute(col,3));
    const mat=new THREE.PointsMaterial({
      size:.045,vertexColors:true,transparent:true,opacity:.72,
      depthWrite:false,blending:THREE.AdditiveBlending,sizeAttenuation:true
    });
    scene.add(new THREE.Points(geo,mat));

    const dustCount=900, dpos=new Float32Array(dustCount*3);
    for(let i=0;i<dustCount;i++){
      const r=1.2+Math.random()*7.5, th=Math.random()*Math.PI*2, ph=Math.acos(2*Math.random()-1);
      dpos[i*3]=Math.sin(ph)*Math.cos(th)*r;
      dpos[i*3+1]=Math.cos(ph)*r*.55;
      dpos[i*3+2]=Math.sin(ph)*Math.sin(th)*r;
    }
    const dgeo=new THREE.BufferGeometry();
    dgeo.setAttribute("position",new THREE.BufferAttribute(dpos,3));
    const dmat=new THREE.PointsMaterial({
      size:.026,color:0x9187a8,transparent:true,opacity:.22,
      depthWrite:false,blending:THREE.AdditiveBlending,sizeAttenuation:true
    });
    scene.add(new THREE.Points(dgeo,dmat));

    const nebulaMat=new THREE.SpriteMaterial({
      map:TEX.nebula,color:0x6c5a8c,transparent:true,opacity:.10,
      depthWrite:false,blending:THREE.AdditiveBlending
    });
    [[5,3,-11,18],[ -7,-2,-13,20],[2,-5,3,14]].forEach(([x,y,z,s])=>{
      const sp=new THREE.Sprite(nebulaMat.clone());
      sp.position.set(x,y,z); sp.scale.set(s,s,1);
      scene.add(sp);
    });
  })();

  // ---------- core ----------
  const coreGroup=new THREE.Group();
  scene.add(coreGroup);
  const coreGlow=new THREE.Sprite(new THREE.SpriteMaterial({
    map:TEX.glow,color:0xf0d9a8,transparent:true,opacity:.52,
    depthWrite:false,blending:THREE.AdditiveBlending
  }));
  coreGlow.scale.set(1.9,1.9,1);
  coreGroup.add(coreGlow);

  const coreHalo=new THREE.Sprite(new THREE.SpriteMaterial({
    map:TEX.glow,color:0xd8b56e,transparent:true,opacity:.22,
    depthWrite:false,blending:THREE.AdditiveBlending
  }));
  coreHalo.scale.set(1.3,1.3,1);
  coreGroup.add(coreHalo);

  coreGroup.add(new THREE.Mesh(
    new THREE.SphereGeometry(.075,20,20),
    new THREE.MeshBasicMaterial({color:0xfff7e6})
  ));

  const ringGroup=new THREE.Group();
  coreGroup.add(ringGroup);
  [
    {r:1.15,rot:[1.20,.15,.0],op:.14},
    {r:1.55,rot:[1.72,.55,.4],op:.10},
    {r:1.92,rot:[2.05,-.35,.2],op:.08}
  ].forEach(o=>{
    const m=new THREE.Mesh(
      new THREE.RingGeometry(o.r,o.r+.006,160),
      new THREE.MeshBasicMaterial({
        color:0xd8b56e,transparent:true,opacity:o.op,side:THREE.DoubleSide,
        depthWrite:false,blending:THREE.AdditiveBlending
      })
    );
    m.rotation.set(o.rot[0],o.rot[1],o.rot[2]);
    ringGroup.add(m);
  });

  // faint celestial shell + wide orbit rings; makes the volume readable
  const shell=new THREE.Mesh(
    new THREE.SphereGeometry(4.35,24,12),
    new THREE.MeshBasicMaterial({
      color:0x7b8798,wireframe:true,transparent:true,opacity:.026,
      depthWrite:false,blending:THREE.AdditiveBlending
    })
  );
  scene.add(shell);

  const orbitGroup=new THREE.Group();
  scene.add(orbitGroup);
  [
    {r:2.75,rot:[1.30,.20,.10],op:.055},
    {r:3.35,rot:[1.62,.75,.35],op:.040},
    {r:3.95,rot:[1.92,-.40,.18],op:.030}
  ].forEach(o=>{
    const m=new THREE.Mesh(
      new THREE.RingGeometry(o.r,o.r+.008,180),
      new THREE.MeshBasicMaterial({
        color:0xd8b56e,transparent:true,opacity:o.op,side:THREE.DoubleSide,
        depthWrite:false,blending:THREE.AdditiveBlending
      })
    );
    m.rotation.set(o.rot[0],o.rot[1],o.rot[2]);
    orbitGroup.add(m);
  });

  // ---------- background dust ----------
  const dustGroup=new THREE.Group();
  scene.add(dustGroup);

  function makeDust(count,color,size,opacity,inner,outer){
    const geo=new THREE.BufferGeometry();
    const pos=new Float32Array(count*3);
    for(let i=0;i<count;i++){
      const u=rand()*2-1;
      const theta=rand()*Math.PI*2;
      const r=inner+Math.pow(rand(),.65)*(outer-inner);
      const s=Math.sqrt(1-u*u);
      pos[i*3]=Math.cos(theta)*s*r;
      pos[i*3+1]=u*r*.72;
      pos[i*3+2]=Math.sin(theta)*s*r;
    }
    geo.setAttribute("position",new THREE.BufferAttribute(pos,3));
    const mat=new THREE.PointsMaterial({
      color,size,transparent:true,opacity,depthWrite:false,
      blending:THREE.AdditiveBlending,sizeAttenuation:true
    });
    const points=new THREE.Points(geo,mat);
    dustGroup.add(points);
  }

  makeDust(820,0x7f8a9b,.018,.34,4.4,9.8);
  makeDust(260,0xc7ad7e,.026,.24,5.2,10.4);
  makeDust(120,0xd9c7a3,.034,.18,6.2,10.8);

  // ---------- clusters ----------
  const sprites=[];
  const clusterLabelData=[];
  const clusterGroups=[];

  function buildClusters(){
    CLASSES.forEach(c=>{
    const group=new THREE.Group();
    group.position.set(c.center[0],c.center[1],c.center[2]);
    group.rotation.set(c.rot[0],c.rot[1],c.rot[2]);
    scene.add(group);
    group.updateMatrixWorld(true);
    clusterGroups.push(group);

    const members=c.members;

    const basePattern=PATTERNS[c.pattern];
    members.forEach((n,i)=>{
      const hub=n.type==="traffic";
      if(c.hub)i--;
      let p;
      if(hub){
        p=[0,0];
      }else if(i<basePattern.length){
        p=basePattern[i];
      }else{
        const angle=i*2.3999632297;
        const radius=.68+Math.floor((i-basePattern.length)/6)*.22;
        p=[Math.cos(angle)*radius,Math.sin(angle)*radius];
      }
      const local=new THREE.Vector3(
        p[0]*c.spread,
        p[1]*c.spread*.78,
        hub?0:(rand()-.5)*c.depth
      );
      const base=hub?.38:.24;

      const hMat=new THREE.SpriteMaterial({
        map:TEX.ring,color:c.color,transparent:true,opacity:0,
        depthWrite:false,blending:THREE.AdditiveBlending
      });
      const halo=new THREE.Sprite(hMat);
      halo.position.copy(local);
      halo.scale.setScalar(base*2.4);
      group.add(halo);

      const mat=new THREE.SpriteMaterial({
        map:TEX.glow,color:c.color,transparent:true,opacity:.8,
        depthWrite:false,blending:THREE.AdditiveBlending
      });
      const sprite=new THREE.Sprite(mat);
      sprite.position.copy(local);
      sprite.scale.setScalar(base);
      sprite.renderOrder=2;
      sprite.userData.node=n;
      group.add(sprite);

      n._sprite=sprite; n._halo=halo; n._group=group; n._local=local.clone();
      n._world=local.clone().applyMatrix4(group.matrixWorld);
      n._base=base;
      sprites.push(sprite);
    });

    if(!c.hub)return;
    const labelPos=group.localToWorld(new THREE.Vector3(0,c.labelY,0));
    const tag=document.createElement("div");
    tag.className="cluster-tag";
    const title=document.createElement("b");
    title.textContent=c.hub.label;
    tag.append(title,document.createElement("i"));
    el.labels.appendChild(tag);
    clusterLabelData.push({c,tag,pos:labelPos,baseOpacity:1});
    });
  }

  function clearClusters(){
    clusterLabelData.forEach(d=>d.tag.remove());
    clusterLabelData.length=0;
    clusterGroups.forEach(g=>{
      g.traverse(o=>{
        if(o.geometry)o.geometry.dispose();
        if(o.material){
          if(Array.isArray(o.material))o.material.forEach(m=>m.dispose());
          else o.material.dispose();
        }
      });
      scene.remove(g);
    });
    clusterGroups.length=0;
    sprites.length=0;
  }

  const coreTag=document.createElement("div");
  coreTag.className="core-tag";
  coreTag.textContent="ECHO";
  el.labels.appendChild(coreTag);
  const coreLabelPos=new THREE.Vector3(0,.48,0);

  const LINK_TYPES={"memory-link":{color:0xc5a878},"traffic-link":{color:0x9db8d8}};
  const links=[];
  const linkGroup=new THREE.Group();
  scene.add(linkGroup);

  function clearRelations(){
    links.forEach(l=>{
      linkGroup.remove(l.line);
      l.line.geometry.dispose();
      l.line.material.dispose();
      scene.remove(l.pulse);
      l.pulse.material.dispose();
    });
    links.length=0;
  }

  function crossClusterCurve(a,b){
      const mid=a._world.clone().add(b._world).multiplyScalar(.5);
      const outward=mid.clone();
      if(outward.lengthSq()<.04)outward.set(0,1,0);
      outward.normalize().multiplyScalar(.38);
      const ctrl=mid.clone().add(outward);
      ctrl.y+=.12;
      const curve=new THREE.QuadraticBezierCurve3(a._world,ctrl,b._world);
      return curve;
  }

  function buildRelations(){
    externalEdges.forEach(({a,b,kind:type})=>{
      const local=a._group===b._group;
      const curve=local?new THREE.LineCurve3(a._world,b._world):crossClusterCurve(a,b);
      const geo=new THREE.BufferGeometry().setFromPoints(curve.getPoints(local?1:26));
      const meta=LINK_TYPES[type];
      const mat=new THREE.LineDashedMaterial({
        color:meta.color,transparent:true,opacity:.105,
        dashSize:.10,gapSize:.075,scale:1,
        depthWrite:false,blending:THREE.AdditiveBlending
      });
      const line=new THREE.Line(geo,mat);
      if(local){
        mat.dashSize=1;mat.gapSize=0;
        mat.color.copy(a._sprite.material.color);
      }
      line.computeLineDistances();
      line.renderOrder=1;
      linkGroup.add(line);

      const pulse=new THREE.Sprite(new THREE.SpriteMaterial({
        map:TEX.glow,color:meta.color,transparent:true,opacity:0,
        depthWrite:false,blending:THREE.AdditiveBlending
      }));
      pulse.scale.setScalar(.065);
      pulse.renderOrder=3;
      scene.add(pulse);
      links.push({line,a,b,type,base:local ? .35 : .19,curve,pulse,pulseActive:false,offset:rand()});
    });
  }

  function updateLinks(){
    const focus=new Set();
    if(state.hover)focus.add(state.hover);
    if(state.selected)focus.add(state.selected);
    links.forEach(l=>{
      if(!l.line.visible){
        l.pulseActive=false;
        return;
      }
      let target=l.base;
      let active=false;
      if(focus.size){
        active=focus.has(l.a.id)||focus.has(l.b.id);
        target=active?.78:.035;
      }
      l.pulseActive=active;
      l.line.material.opacity+=(target-l.line.material.opacity)*.32;
      l.pulse.material.opacity+=((active?.95:0)-l.pulse.material.opacity)*.14;
    });
  }

  // ---------- picking ----------
  const raycaster=new THREE.Raycaster();
  const pointer=new THREE.Vector2();
  let downPoint={x:0,y:0};
  let hoverRaf=0, lastMove=null;

  function setPointer(e){
    const r=renderer.domElement.getBoundingClientRect();
    pointer.x=((e.clientX-r.left)/r.width)*2-1;
    pointer.y=-((e.clientY-r.top)/r.height)*2+1;
  }
  function pick(e){
    setPointer(e);
    raycaster.setFromCamera(pointer,camera);
    const hits=raycaster.intersectObjects(sprites.filter(s=>s.visible),false);
    return hits.length?hits[0].object.userData.node:null;
  }
  function showTip(n,e){
    if(state.hover!==n.id){state.hover=n.id;updateLinks();}
    el.tooltip.firstElementChild.textContent=n.label;
    el.tooltip.lastElementChild.textContent=n.type==="traffic"?"交通节点":"记忆节点";
    el.tooltip.classList.add("show"); moveTip(e);
  }
  function moveTip(e){
    const w=el.tooltip.offsetWidth||170,h=el.tooltip.offsetHeight||40,pad=12;
    let x=e.clientX+14,y=e.clientY+14;
    if(x+w>innerWidth-pad)x=e.clientX-w-14;
    if(y+h>innerHeight-pad)y=e.clientY-h-14;
    el.tooltip.style.left=x+"px"; el.tooltip.style.top=y+"px";
  }
  function hideTip(){
    el.tooltip.classList.remove("show");
    if(state.hover){state.hover=null;updateLinks();}
  }

  el.canvas.addEventListener("pointerdown",e=>{
    downPoint={x:e.clientX,y:e.clientY};
    hideTip();
  });
  el.canvas.addEventListener("click",e=>{
    if(Math.hypot(e.clientX-downPoint.x,e.clientY-downPoint.y)>6)return;
    const n=pick(e);
    onSelect(n);
  });
  el.canvas.addEventListener("pointermove",e=>{
    if(e.pointerType==="touch"||e.buttons)return;
    lastMove=e;
    if(hoverRaf)return;
    hoverRaf=requestAnimationFrame(()=>{
      hoverRaf=0;
      if(!lastMove)return;
      const n=pick(lastMove);
      if(n)showTip(n,lastMove); else hideTip();
    });
  });
  el.canvas.addEventListener("pointerleave",hideTip);

  // ---------- labels ----------
  const labelVec=new THREE.Vector3();
  function updateLabels(){
    camera.updateMatrixWorld();
    const w=window.innerWidth,h=window.innerHeight;
    clusterLabelData.forEach(d=>{
      labelVec.copy(d.pos).project(camera);
      const behind=labelVec.z>1||labelVec.z<-1;
      const x=(labelVec.x*.5+.5)*w, y=(-labelVec.y*.5+.5)*h;
      if(!d.c.hub._sprite.visible||behind||x<12||x>w-12||y<40||y>h-44){
        d.tag.style.opacity="0"; return;
      }
      d.tag.style.transform=`translate3d(${x}px,${y}px,0) translate(-50%,-110%)`;
      d.tag.style.opacity=String(d.baseOpacity*.96);
    });
    labelVec.copy(coreLabelPos).project(camera);
    const behind=labelVec.z>1||labelVec.z<-1;
    const x=(labelVec.x*.5+.5)*w, y=(-labelVec.y*.5+.5)*h;
    coreTag.style.transform=`translate3d(${x}px,${y}px,0) translate(-50%,-50%)`;
    coreTag.style.opacity=behind||!NODES.length?"0":".95";
  }

  // ---------- animate ----------
  function animate(){
    requestAnimationFrame(animate);
    const t=performance.now();
    if(autoResume&&t>autoResume){controls.autoRotate=motion&&!state.selected;autoResume=0;}
    if(cameraGoal){
      const delta=cameraGoal.clone().sub(controls.target);
      delta.multiplyScalar(reduce?1:.12);
      controls.target.add(delta);
      camera.position.add(delta);
      if(cameraGoal.distanceToSquared(controls.target)<.00001)cameraGoal=null;
    }
    controls.update();

    if(motion){
    coreGroup.rotation.y+=.0009;
    ringGroup.rotation.z+=.0012;
    ringGroup.rotation.x+=.0004;
    orbitGroup.rotation.y+=.00035;
    orbitGroup.rotation.x+=.00012;
    dustGroup.rotation.y+=.000055;
    }

    NODES.forEach(n=>{
      if(!n._halo)return;
      if(state.selected===n.id){
        const p=motion?.72+.20*Math.sin(t*.004):.85;
        n._halo.material.opacity=p;
        n._halo.scale.setScalar(n._base*(motion?2.9+.22*Math.sin(t*.004):2.9));
      }
    });

    updateLinks();
    links.forEach(l=>{
      if(!l.pulseActive)return;
      const t=motion?(performance.now()*.00011+l.offset)%1:.5;
      l.pulse.position.copy(l.curve.getPoint(t));
    });
    updateLabels();
    renderer.render(scene,camera);
  }

  // ---------- resize ----------
  function resize(){
    camera.aspect=window.innerWidth/window.innerHeight;
    // On portrait screens keep both sides of the original orbital shell in view.
    camera.zoom=Math.min(1,camera.aspect/1.06);
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
    renderer.setSize(window.innerWidth,window.innerHeight);
  }
  window.addEventListener("resize",resize,{passive:true});

  coreGroup.visible=orbitGroup.visible=shell.visible=false;
  function setData(graph){
    clearRelations();
    clearClusters();
    hideTip();
    state.selected=null;
    NODES=graph.nodes;
    externalEdges=graph.edges;
    CLASSES=graph.groups.map((g,i,groups)=>{
      const template=LAYOUT[i%LAYOUT.length];
      let center=template.center;
      if(groups.length>LAYOUT.length){
        const y=1-2*(i+.5)/groups.length;
        const ring=Math.sqrt(1-y*y), angle=i*2.3999632297;
        center=[2.75*ring*Math.cos(angle),2*y,2.25*ring*Math.sin(angle)];
      }
      return {...template,...g,pattern:template.id,center};
    });
    buildClusters();
    buildRelations();
    coreGroup.visible=orbitGroup.visible=shell.visible=Boolean(NODES.length);
  }
  function setVisibility(visible,showLines){
    NODES.forEach(n=>{
      n._sprite.visible=n._halo.visible=visible(n);
      n._halo.material.opacity=n.id===state.selected ? .85 : (n.type==="traffic" ? .62 : 0);
      n._halo.scale.setScalar(n._base*(n.type==="traffic"?1.6:2.4));
    });
    links.forEach(l=>{l.line.visible=l.pulse.visible=showLines&&l.a._sprite.visible&&l.b._sprite.visible;});
    hideTip();
    updateLinks();
  }
  function select(n,focus=false){
    state.selected=n?.id??null;
    autoResume=0;
    controls.autoRotate=motion&&!n;
    if(focus&&n)cameraGoal=n._world.clone();
    NODES.forEach(item=>{
      item._halo.material.opacity=item===n ? .85 : (item.type==="traffic" ? .62 : 0);
      item._halo.scale.setScalar(item._base*(item.type==="traffic"?1.6:2.4));
    });
    updateLinks();
  }
  function reset(){
    cameraGoal=null;
    controls.reset();
    camera.position.set(3.4,2.4,7.4);
    controls.target.set(0,0,0);
    resize();
    controls.update();
    select(null);
  }
  function setMotion(enabled){
    motion=enabled;
    autoResume=0;
    controls.autoRotate=motion&&!state.selected;
  }
  resize();
  animate();
  return {setData,setVisibility,select,reset,setMotion};
}
