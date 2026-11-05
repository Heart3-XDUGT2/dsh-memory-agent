/* Local camera and pointer lifecycle. Never changes audit data or persisted positions. */
(function(root){
  'use strict';
  root.EchoRoundMap={attach};
  function attach(view,world,options){
    const controller=new AbortController(),signal=controller.signal,points=new Map();
    let camera={x:0,y:0,k:1},animation=0,gesture=null,suppressed=false,suppressTimer=0,destroyed=false,moving=false;
    function suppress(){suppressed=true;clearTimeout(suppressTimer);suppressTimer=setTimeout(()=>{suppressed=false;suppressTimer=0;},0);}
    let fitMinimum=.3;
    const clamp=k=>Math.max(fitMinimum,Math.min(2.2,k));
    const local=e=>{const r=view.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};};
    const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
    function paint(){world.style.transform=`translate(${camera.x}px,${camera.y}px) scale(${camera.k})`;view.dataset.scale=String(camera.k);view.classList.toggle('is-overview',camera.k<.7);options.onCamera?.({...camera});}
    function cancel(){if(animation)cancelAnimationFrame(animation);animation=0;world.style.willChange='';}
    function interrupt(){cancel();options.onInterrupt?.();}
    function set(next,animate=false){
      cancel();const goal={x:next.x,y:next.y,k:clamp(next.k)};
      if(!animate||reduced()){camera=goal;paint();return;}
      const from={...camera},start=performance.now();world.style.willChange='transform';
      const tick=now=>{const t=Math.min(1,(now-start)/280),ease=1-Math.pow(1-t,4);camera={x:from.x+(goal.x-from.x)*ease,y:from.y+(goal.y-from.y)*ease,k:from.k+(goal.k-from.k)*ease};paint();if(t<1&&!destroyed)animation=requestAnimationFrame(tick);else{animation=0;world.style.willChange='';}};
      animation=requestAnimationFrame(tick);
    }
    function zoom(factor,anchor={x:view.clientWidth/2,y:view.clientHeight/2},animate=true){
      const k=clamp(camera.k*factor),wx=(anchor.x-camera.x)/camera.k,wy=(anchor.y-camera.y)/camera.k;
      set({x:anchor.x-wx*k,y:anchor.y-wy*k,k},animate);
    }
    function fit(bounds,initial=false){
      const pad=initial?36:28,top=initial?pad:72,bottom=initial?pad:(view.clientWidth<600?148:92);
      const usableW=Math.max(1,view.clientWidth-pad*2),usableH=Math.max(1,view.clientHeight-top-bottom);
      let k=Math.min(1,usableW/Math.max(1,bounds.w),usableH/Math.max(1,bounds.h));
      if(initial)k=view.clientWidth<600?1:Math.max(.8,k);
      // Explicit overview may go below the reading scale; record focus restores legibility.
      fitMinimum=initial ? .3 : Math.min(.3,k);
      k=clamp(k);const cx=bounds.x+bounds.w/2,cy=bounds.y+bounds.h/2;
      set({x:view.clientWidth/2-cx*k,y:top+usableH/2-cy*k,k},!initial);
    }
    function focus(box,reserved=0){
      const width=Math.max(200,view.clientWidth-reserved),height=view.clientHeight,k=Math.max(.9,camera.k);
      set({x:width/2-(box.x+box.w/2)*k,y:height*.43-(box.y+box.h/2)*k,k},true);
    }
    function release(){
      if(gesture?.kind==='node'&&moving)options.onNodeCommit?.(gesture.node,gesture.dx,gesture.dy);
      const ids=[...points.keys()];points.clear();gesture=null;moving=false;
      for(const id of ids)if(view.hasPointerCapture(id))view.releasePointerCapture(id);
      view.classList.remove('is-panning');world.style.willChange='';
    }
    function begin(){
      const list=[...points.values()];
      if(list.length>=2){const a=list[0],b=list[1],center={x:(a.x+b.x)/2,y:(a.y+b.y)/2};gesture={kind:'pinch',distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),anchor:{x:(center.x-camera.x)/camera.k,y:(center.y-camera.y)/camera.k},camera:{...camera}};}
      else if(list.length){const p=list[0];gesture={kind:p.node!==null&&options.adjusting?.()?'node':'pan',node:p.node,start:{...p},camera:{...camera},dx:0,dy:0};}
    }
    view.addEventListener('pointerdown',e=>{
      if(e.button!==0||e.target.closest('.rm-overlay,.rm-hud,.rm-dock,.rm-zoom,.rm-status,.rm-header'))return;
      e.preventDefault();
      interrupt();const p=local(e),node=e.target.closest('.rg-node');p.node=node?Number(node.dataset.node):null;p.target=e.target.closest('.rg-node,.rg-edge');
      if(gesture?.kind==='node'&&moving)options.onNodeCommit?.(gesture.node,gesture.dx,gesture.dy);
      points.set(e.pointerId,p);view.setPointerCapture(e.pointerId);begin();view.focus({preventScroll:true});
    },{signal});
    view.addEventListener('pointermove',e=>{
      if(!points.has(e.pointerId)||!gesture)return;
      const p=local(e),old=points.get(e.pointerId);points.set(e.pointerId,{...p,node:old.node});
      if(points.size>=2){
        const [a,b]=[...points.values()],center={x:(a.x+b.x)/2,y:(a.y+b.y)/2},k=clamp(gesture.camera.k*Math.hypot(a.x-b.x,a.y-b.y)/gesture.distance);
        moving=true;camera={x:center.x-gesture.anchor.x*k,y:center.y-gesture.anchor.y*k,k};paint();
      }else{
        const dx=p.x-gesture.start.x,dy=p.y-gesture.start.y;if(!moving&&Math.hypot(dx,dy)<5)return;
        moving=true;view.classList.add('is-panning');world.style.willChange='transform';
        if(gesture.kind==='node'){gesture.dx=dx/camera.k;gesture.dy=dy/camera.k;options.onNodeDrag?.(gesture.node,gesture.dx,gesture.dy);}
        else{camera={...gesture.camera,x:gesture.camera.x+dx,y:gesture.camera.y+dy};paint();}
      }
    },{signal});
    function end(e){
      if(!points.has(e.pointerId))return;
      const wasMoving=moving,tapped=!wasMoving&&gesture?.kind!=='pinch'?gesture?.start?.target:null;if(gesture?.kind==='node'&&moving)options.onNodeCommit?.(gesture.node,gesture.dx,gesture.dy);
      points.delete(e.pointerId);if(view.hasPointerCapture(e.pointerId))view.releasePointerCapture(e.pointerId);
      if(wasMoving||tapped)suppress();
      if(tapped)options.onTap?.(tapped);
      if(points.size){moving=false;begin();}else{gesture=null;moving=false;view.classList.remove('is-panning');world.style.willChange='';}
    }
    view.addEventListener('pointerup',end,{signal});
    view.addEventListener('pointercancel',()=>{suppress();release();},{signal});
    view.addEventListener('lostpointercapture',e=>{if(points.has(e.pointerId)){suppress();release();}},{signal});
    view.addEventListener('click',e=>{if(suppressed){e.preventDefault();e.stopImmediatePropagation();}}, {capture:true,signal});
    view.addEventListener('wheel',e=>{
      if(e.target.closest('.rm-overlay,.rm-hud,.rm-dock,.rm-zoom,.rm-status'))return;
      e.preventDefault();interrupt();zoom(Math.exp(-Math.max(-200,Math.min(200,e.deltaY))*.002),local(e),true);
    },{passive:false,signal});
    view.addEventListener('keydown',e=>{
      if(e.target.closest('.rm-overlay,input,textarea,select,button,a,summary')||e.altKey||e.ctrlKey||e.metaKey)return;
      const delta={ArrowLeft:[70,0],ArrowRight:[-70,0],ArrowUp:[0,70],ArrowDown:[0,-70]}[e.key];
      if(delta){e.preventDefault();interrupt();set({...camera,x:camera.x+delta[0],y:camera.y+delta[1]},!reduced());}
      else if(e.key==='+'||e.key==='='){e.preventDefault();interrupt();zoom(1.2);}
      else if(e.key==='-'){e.preventDefault();interrupt();zoom(1/1.2);}
      else if(e.key==='0'){e.preventDefault();interrupt();options.onFit?.();}
      else if(e.key==='Home'){e.preventDefault();interrupt();options.onReset?.();}
    },{signal});
    document.addEventListener('visibilitychange',()=>{if(document.hidden){cancel();release();}},{signal});
    paint();return {set,zoom,fit,focus,cancel,get:()=>({...camera}),active:()=>({pointers:points.size,animation:!!animation}),destroy(){destroyed=true;cancel();release();clearTimeout(suppressTimer);suppressTimer=0;controller.abort();},interrupt};
  }
})(globalThis);
