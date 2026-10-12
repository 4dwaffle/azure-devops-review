const storageKey='azure-filtered-review:sidebar-width';
export function initializeSidebar(main,resizer,storage){
 let preferred=null,dragging=null;
 try{const saved=Number(storage.getItem(storageKey));if(Number.isFinite(saved)&&saved>0)preferred=saved;}catch{}
 const limits=()=>{const min=Math.min(180,Math.max(0,main.clientWidth-5));return {min,max:Math.max(min,main.clientWidth-245)};};
 const clamp=width=>{const {min,max}=limits();return Math.min(max,Math.max(min,width));};
 const width=()=>main.querySelector('.file-sidebar').getBoundingClientRect().width;
 function apply(){
  if(preferred!==null)main.style.setProperty('--sidebar-width',`${clamp(preferred)}px`);
  const {min,max}=limits();
  resizer.setAttribute('aria-valuemin',String(Math.round(min)));
  resizer.setAttribute('aria-valuemax',String(Math.round(max)));
  resizer.setAttribute('aria-valuenow',String(Math.round(width())));
 }
 function save(){try{if(preferred===null)storage.removeItem(storageKey);else storage.setItem(storageKey,String(preferred));}catch{}}
 function finish(event){if(event.pointerId!==dragging)return;dragging=null;resizer.classList.remove('dragging');save();}
 resizer.addEventListener('pointerdown',event=>{
  if(event.button!==0||dragging!==null)return;
  event.preventDefault();dragging=event.pointerId;resizer.focus();resizer.setPointerCapture(event.pointerId);resizer.classList.add('dragging');
 });
 resizer.addEventListener('pointermove',event=>{
  if(event.pointerId!==dragging)return;
  preferred=clamp(event.clientX-main.getBoundingClientRect().left);apply();
 });
 for(const type of ['pointerup','pointercancel','lostpointercapture'])resizer.addEventListener(type,finish);
 resizer.addEventListener('keydown',event=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();const {min,max}=limits();
  preferred=clamp(event.key==='Home'?min:event.key==='End'?max:width()+(event.key==='ArrowLeft'?-1:1)*(event.shiftKey?40:10));apply();save();
 });
 resizer.addEventListener('dblclick',()=>{preferred=null;main.style.removeProperty('--sidebar-width');apply();save();});
 new ResizeObserver(apply).observe(main);apply();
}
