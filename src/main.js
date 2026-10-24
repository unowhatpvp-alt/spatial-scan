import { english } from './i18n.js';
import { CaptureSet } from './capture.js';
import { createEngine } from './engine.js';
import { createViewer } from './viewer.js';
import { toGLB, toPLY, downloadFile } from './export.js';
import { listModels, putModel, deleteModel } from './storage.js';
const $=id=>document.getElementById(id);
const zh=Object.fromEntries([...document.querySelectorAll('[data-i18n]')].map(e=>[e.dataset.i18n,e.innerHTML]));
english.reconstructNote='At least 2 overlapping photos with sideways camera motion';
zh.reconstructNote='至少需要 2 张重叠、带有平移视差的照片';
let language='zh',theme='light';
try{language=localStorage.getItem('spatial-language')||'zh';theme=localStorage.getItem('spatial-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');}catch{}
const copy=(cn,en)=>language==='zh'?cn:en;
const text=key=>(language==='zh'?zh:english)[key]||english[key]||key;
const limited=/iPhone|iPad|Android/i.test(navigator.userAgent)||(navigator.deviceMemory&&navigator.deviceMemory<4)||(navigator.hardwareConcurrency&&navigator.hardwareConcurrency<4);
const capture=new CaptureSet({limit:limited?24:32,maxEdge:limited?640:900});
let stream=null,autoTimer=null,viewer=null,model=null,modelSaved=false,busy=false,importing=false,engineReady=false,offlineCached=false,shellCached=false,engineDownloading=false,toastTimer=null,currentView='scan',lastStatus=null,capturePending=false,activeReconstruction=null,saving=false,modelId=null,cameraStarting=false,cameraGeneration=0;
function notify(message,error=false){$('toast').textContent=message;$('toast').classList.toggle('error',error);$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,error?10000:5000);}
function engineLabels(){
  $('engineLabel').textContent=engineReady?copy('引擎就绪','Engine ready'):engineDownloading?copy('正在准备','Preparing'):copy('等待准备','Not loaded');
  $('engineDot').classList.toggle('ready',engineReady);$('prepareEngine').textContent=engineReady?(offlineCached?copy('视觉引擎已缓存 ✓','Vision engine cached ✓'):copy('引擎就绪 · 未缓存','Ready · not cached')):engineDownloading?copy('正在准备…','Preparing…'):text('prepareEngine');
  $('prepareEngine').disabled=engineDownloading||engineReady||busy;
  $('engineDetail').textContent=engineReady?(offlineCached&&shellCached?copy('离线资源就绪 · WASM / CPU · 无上传','Offline assets ready · WASM / CPU · no uploads'):copy('WASM / CPU · 本机计算 · 无上传','WASM / CPU · on-device · no uploads')):text('engineDescription');
  $('offlineBadge').textContent=navigator.onLine?copy('在线','ONLINE'):copy('离线','OFFLINE');
}
function applyLanguage(){
  document.documentElement.lang=language==='zh'?'zh-CN':'en';document.title=language==='zh'?'Spatial Scan — 本地三维扫描':'Spatial Scan — Local 3D scanning';
  for(const e of document.querySelectorAll('[data-i18n]')){const value=text(e.dataset.i18n);if(value)e.innerHTML=value;}
  $('language').textContent=language==='zh'?'EN':'中文';
  $('deviceBadge').textContent=(limited?copy('移动设备','MOBILE'):copy('桌面设备','DESKTOP'))+' · '+capture.maxEdge+'px / '+capture.limit+copy(' 张上限',' views max');
  $('cameraTip').textContent=copy('缓慢横向移动 · 保持画面重叠 · 避免原地旋转','Move sideways slowly · keep overlap · avoid rotating in place');
  $('toggleAuto').textContent=autoTimer?copy('停止采集','Stop auto'):text('autoCapture');
  engineLabels();renderFrames();sync();if(model)resultStats();if(currentView==='library')renderLibrary();
}
function applyTheme(){document.documentElement.dataset.theme=theme;document.querySelector('meta[name=theme-color]').content=theme==='dark'?'#181a18':'#f6f5f1';viewer?.setTheme(theme);}
function showView(view){
  currentView=view;for(const name of ['scan','library','guide'])$(name+'View').hidden=name!==view;
  for(const button of document.querySelectorAll('[data-view]')){button.classList.toggle('active',button.dataset.view===view);button.setAttribute('aria-pressed',String(button.dataset.view===view));}
  if(view!=='scan'&&autoTimer)stopAuto();if(view==='library')renderLibrary();
}
function sync(){
  const locked=busy||importing||capturePending||cameraStarting;
  $('frameCount').textContent=capture.frames.length;
  for(const id of ['addPhotos','importPhotos','startCamera','restartCamera'])$(id).disabled=locked;
  $('reconstruct').disabled=locked||capture.frames.length<2;
  $('clearFrames').disabled=locked||(!capture.frames.length&&!model);
  $('captureFrame').disabled=locked||!stream||capture.frames.length>=capture.limit;
  $('toggleAuto').disabled=locked||!stream||capture.frames.length>=capture.limit;
  $('stopCamera').disabled=(!stream&&!cameraStarting)||busy;
  $('clearCache').disabled=busy||engineDownloading;
  $('fov').disabled=busy;$('dense').disabled=busy;
  $('stage').setAttribute('aria-busy',String(busy));
  $('saveModel').disabled=locked||saving||!model||modelSaved;
  for(const b of $('frameStrip').querySelectorAll('.frame-remove'))b.disabled=locked;
  $('saveModel').textContent=modelSaved?copy('已保存到本机 ✓','Saved on this device ✓'):saving?copy('正在保存…','Saving…'):text('saveModel');
  $('stepCapture').className=busy||model?'done':'current';
  $('stepBuild').className=busy?'current':model?'done':'';
  $('stepExport').className=model&&!busy?'current':'';
  $('stageLabel').textContent=model&&!stream?copy('MODEL / 三维点云','MODEL / 3D POINT CLOUD'):text('captureLabel');
  if(capture.frames.length&&!model&&!stream){$('emptyStage').querySelector('h2').textContent=copy(capture.frames.length+' 个真实视角，等待重建',capture.frames.length+' real views. Ready to reconstruct.');}
}
function renderFrames(){
  const strip=$('frameStrip');strip.replaceChildren();
  if(!capture.frames.length){const p=document.createElement('p');p.className='strip-placeholder';p.innerHTML=text('framesPlaceholder');strip.append(p);}
  capture.frames.forEach((frame,index)=>{const item=document.createElement('div');item.className='frame';const image=document.createElement('img');image.src=frame.url;image.alt=copy('视角 ','View ')+(index+1);const number=document.createElement('span');number.className='frame-number';number.textContent=String(index+1).padStart(2,'0');const remove=document.createElement('button');remove.className='frame-remove';remove.textContent='×';remove.setAttribute('aria-label',copy('移除视角 ','Remove view ')+(index+1));remove.disabled=busy||importing;remove.onclick=()=>{capture.remove(index);renderFrames();sync();};item.append(image,number,remove);strip.append(item);});
}
function captureError(error){
  const messages={limit:copy('已达到设备建议上限，请先重建或清空视角。','View limit reached. Reconstruct or clear this sequence first.'),aspect:copy('请使用同一相机、画面方向和宽高比；本次照片已跳过。','Use the same camera, orientation and aspect ratio. This view was skipped.'),decode:copy('无法读取这张照片。请尝试 JPG、PNG 或 WebP。','Could not decode this photo. Try JPG, PNG or WebP.'),size:copy('单张照片过大，请先将照片缩小到 35 MB 以下。','Photo is too large. Resize it below 35 MB first.')};return messages[error.code]||error.message||copy('无法处理这张照片。','Could not process this photo.');
}
async function startCamera(){
  if(busy||importing||capturePending||stream||cameraStarting)return;
  const requestId=++cameraGeneration;cameraStarting=true;sync();
  try{
    if(!navigator.mediaDevices?.getUserMedia)throw Error('unavailable');
    $('startCamera').disabled=true;
    const requestedStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:960}},audio:false});
    if(requestId!==cameraGeneration){requestedStream.getTracks().forEach(t=>t.stop());return;}stream=requestedStream;
    const video=$('camera');video.srcObject=stream;
    await new Promise((resolve,reject)=>{if(video.readyState>=1)return resolve();const timer=setTimeout(()=>reject(Error('unavailable')),12000);video.onloadedmetadata=()=>{clearTimeout(timer);video.onloadedmetadata=null;resolve();};});
    if(requestId!==cameraGeneration)return;await video.play();if(requestId!==cameraGeneration)return;$('emptyStage').hidden=true;$('viewer').hidden=true;$('viewerToolbar').hidden=true;video.hidden=false;$('cameraOverlay').hidden=false;
    $('videoResolution').textContent=video.videoWidth+' × '+video.videoHeight;sync();
  }catch(error){if(requestId!==cameraGeneration)return;stopCamera();notify(error.name==='NotAllowedError'?copy('摄像头未获授权。请在地址栏允许相机，或导入照片。','Camera access was denied. Allow it in site settings or import photos.'):copy('摄像头暂不可用。可导入同一场景的重叠照片继续。','Camera unavailable. Import overlapping photos of the same scene to continue.'),true);}finally{if(requestId===cameraGeneration){cameraStarting=false;sync();}}
}
function stopAuto(){if(autoTimer)clearInterval(autoTimer);autoTimer=null;$('toggleAuto').classList.remove('recording');$('toggleAuto').textContent=text('autoCapture');}
function stopCamera(){cameraGeneration++;cameraStarting=false;stopAuto();stream?.getTracks().forEach(track=>track.stop());stream=null;$('camera').srcObject=null;$('camera').hidden=true;$('cameraOverlay').hidden=true;if(model){$('viewer').hidden=false;$('viewerToolbar').hidden=false;}else $('emptyStage').hidden=false;sync();}
async function takeFrame(automatic=false){
  if(!stream||capturePending||busy||importing)return;capturePending=true;sync();
  try{const result=await capture.add($('camera'),{automatic});if(result.skipped){$('cameraTip').textContent=result.skipped==='blur'?copy('画面较模糊，请稳定手机并增加光线','Hold the camera steady and improve the light'):copy('向侧面移动一点，增加视差','Move a little sideways to create parallax');}else{renderFrames();sync();$('frameStrip').scrollLeft=$('frameStrip').scrollWidth;$('cameraTip').textContent=copy('已采集 '+capture.frames.length+' 张 · 保持重叠，继续横向移动',capture.frames.length+' views captured · keep overlap and move sideways');if(capture.frames.length>=capture.limit)stopAuto();}}
  catch(error){stopAuto();notify(captureError(error),true);}finally{capturePending=false;sync();}
}
async function importFiles(files){
  if(busy||importing||capturePending)return;importing=true;stopAuto();sync();let count=0,errors=[];
  for(const file of files){try{await capture.addFile(file);count++;}catch(error){errors.push(captureError(error));if(error.code==='limit')break;}}
  importing=false;renderFrames();sync();
  notify(count?copy('已导入 '+count+' 张视角',count+' views imported')+(errors.length?' · '+errors[0]:''):(errors[0]||copy('没有可读取的照片。','No supported photos found.')),!count);
}
function friendlyError(message){
  if(/overlap|sideways|rotation|parallax|establish 3D|same scene/i.test(message))return copy('无法建立可靠三维几何。请横向移动镜头、保持 70–80% 重叠，选择纹理丰富的静止场景；不要只在原地旋转。',message);
  if(/texture|feature|blank|points/i.test(message))return copy('可靠特征或三维点不足。请增加光线、纹理和重叠视角，避免白墙、反光及模糊画面。',message);
  if(/fetch|network|load|engine|WebAssembly/i.test(message))return copy('本地视觉引擎未能启动。请联网重新准备引擎；必要时清除引擎缓存后重试。',message);
  return copy('重建未完成：','Reconstruction failed: ')+message;
}
const engine=createEngine({
  onDownload({progress,loaded,total,cached}){engineDownloading=true;$('engineProgress').value=Number.isFinite(progress)?progress:0;$('engineLabel').textContent=cached?copy('正在读取缓存','Reading cache'):copy('正在下载','Downloading');$('engineDetail').textContent=cached?copy('从本机缓存加载视觉引擎','Loading the engine from device cache'):(loaded/1048576).toFixed(1)+' MB'+(total?' / '+(total/1048576).toFixed(1)+' MB':'');$('prepareEngine').disabled=true;},
  onReady(result){offlineCached=Boolean(result.offlineCached);engineReady=true;engineDownloading=false;$('engineProgress').value=1;engineLabels();sync();},
  onStatus(status){lastStatus=status;if(!busy)return;const stageMessages={loading:copy('启动本地视觉引擎…','Starting local vision engine…'),features:copy('提取各视角的真实图像特征…','Extracting image features…'),matching:copy('匹配视角，计算相机运动…','Matching views and solving camera motion…'),reconstructing:copy('在共同尺度中注册相机与三维点…','Registering cameras and points in one scale…'),densifying:copy('验证局部立体匹配，补充三维点…','Checking stereo matches to add reliable points…')};$('processingMessage').textContent=stageMessages[status.stage]||status.message;$('processingPercent').textContent=Math.round(Math.max(0,Math.min(1,status.progress||0))*100)+'%';}
});
async function prepareEngine({quiet=false}={}){
  if(!('WebAssembly'in window)){notify(copy('此浏览器不支持 WebAssembly，请更新浏览器。','This browser needs WebAssembly support. Please update it.'),true);return;}
  engineDownloading=true;engineLabels();try{await engine.prepare();if(!quiet)notify(copy('本地视觉引擎已就绪。缓存可用时无需重复下载。','Local vision engine ready. Cached assets avoid repeat downloads.'));}catch(error){engineReady=false;if(error.name!=='AbortError')notify(friendlyError(error.message),true);}finally{engineDownloading=false;engineLabels();sync();}
}
async function reconstruct(){
  if(busy||importing||capturePending||capture.frames.length<2)return;
  const fov=Number($('fov').value);if(!Number.isFinite(fov)||fov<25||fov>110){notify(copy('视场角需要在 25° 到 110° 之间。','Field of view must be between 25° and 110°.'),true);return;}
  const run=Symbol('reconstruct');activeReconstruction=run;
  stopCamera();busy=true;showView('scan');$('processingOverlay').hidden=false;$('processingMessage').textContent=copy('准备设备本地图像…','Preparing local image pixels…');$('processingPercent').textContent='0%';renderFrames();sync();
  try{const frames=await capture.pixels(()=>activeReconstruction===run);if(activeReconstruction!==run)throw new DOMException('Cancelled','AbortError');const result=await engine.reconstruct(frames,{fov,maxFeatures:limited?1600:2400,dense:$('dense').checked});if(activeReconstruction!==run)throw new DOMException('Cancelled','AbortError');busy=false;showModel(result);notify(copy('重建完成：'+result.stats.points.toLocaleString()+' 个真实三维点。','Reconstruction complete: '+result.stats.points.toLocaleString()+' real 3D points.'));}
  catch(error){if(error.name!=='AbortError')notify(friendlyError(error.message),true);}
  finally{if(activeReconstruction===run){activeReconstruction=null;busy=false;$('processingOverlay').hidden=true;engineReady=engine.ready;engineDownloading=false;renderFrames();sync();engineLabels();}}
}
function resultStats(){
  const stats=model.stats||{};$('pointCount').textContent=(model.positions.length/3).toLocaleString();$('registeredCount').textContent=(stats.registered||model.cameras?.length||0)+' / '+(stats.frames||model.cameras?.length||0);$('errorValue').textContent=Number.isFinite(stats.reprojectionError)?stats.reprojectionError.toFixed(2)+' px':'—';
  $('resultWarning').textContent=copy('真实点云 · 未标定尺寸 · 空洞表示缺少可靠匹配。','Real point cloud · unmeasured scale · holes indicate missing reliable matches.')+((stats.registered||0)<(stats.frames||0)?copy(' 部分视角无法定位，未加入模型。',' Some views could not be registered and were excluded.'):'');
}
function showModel(result,savedId=null){stopCamera();model=result;modelSaved=Boolean(savedId);modelId=savedId;$('emptyStage').hidden=true;$('viewer').hidden=false;$('viewerToolbar').hidden=false;$('resultPanel').hidden=false;if(!viewer)viewer=createViewer($('viewer'));viewer.setTheme(theme);viewer.setModel(model);viewer.setPointSize(Number($('pointSize').value));resultStats();sync();}
function clearAll(){capture.clear();model=null;modelSaved=false;modelId=null;viewer?.clear();$('viewer').hidden=true;$('viewerToolbar').hidden=true;$('resultPanel').hidden=true;$('exportScale').value=1;if(!stream)$('emptyStage').hidden=false;applyLanguage();}
function exportModel(format){if(!model)return;try{const scale=Number($('exportScale').value);if(!Number.isFinite(scale)||scale<.001||scale>1000)throw Error(copy('请输入 0.001–1000 之间的缩放倍数。','Use an export scale between 0.001 and 1000.'));const name='spatial-scan-'+new Date().toISOString().slice(0,19).replaceAll(':','-');downloadFile(format==='glb'?toGLB(model,scale):toPLY(model,scale),name+'.'+format,format==='glb'?'model/gltf-binary':'application/octet-stream');notify(copy('导出已开始。iPhone 可在下载或分享菜单中保存文件。','Export started. On iPhone, save the file from Downloads or the share menu.'));}catch(error){notify(error.message,true);}}
async function saveCurrent(){
  if(!model||modelSaved||saving)return;saving=true;sync();const snapshot=model;
  try{const created=Date.now(),id=crypto.randomUUID?.()||String(created);await putModel({id,name:copy('空间扫描 ','Spatial scan ')+new Date(created).toLocaleString(language==='zh'?'zh-CN':'en',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}),created,model:snapshot});if(model===snapshot){modelSaved=true;modelId=id;}sync();await updateLibraryCount();notify(copy('已保存到此浏览器的本机模型。','Saved in this browser on this device.'));}catch{notify(copy('本机存储不可用或空间不足。请直接导出 GLB/PLY。','Local storage is unavailable or full. Export GLB/PLY directly.'),true);}finally{saving=false;sync();}
}
async function updateLibraryCount(){try{const entries=await listModels();$('libraryCount').textContent=entries.length;return entries;}catch{$('libraryCount').textContent='—';return null;}}
async function renderLibrary(){
  const entries=await updateLibraryCount(),grid=$('libraryGrid');grid.replaceChildren();
  if(!entries?.length){const empty=document.createElement('div');empty.className='library-empty';const title=document.createElement('h3');title.textContent=entries?copy('下一个空间，等你留住。','Your next space is waiting.'):copy('此浏览器暂不可用本机模型库。','Local library is unavailable in this browser.');const p=document.createElement('p');p.textContent=copy('完成重建后，点击“保存到本机模型”。也可以直接导出文件。','After reconstruction, choose “Save on this device”, or export a file directly.');empty.append(title,p);grid.append(empty);return;}
  for(const entry of entries){const card=document.createElement('article');card.className='panel model-card';const art=document.createElement('div');art.className='model-art';art.textContent=(entry.model.positions.length/3).toLocaleString();const info=document.createElement('div');info.className='model-info';const h=document.createElement('h3');h.textContent=entry.name;const p=document.createElement('p');p.textContent=copy('三维点 · ','3D points · ')+new Date(entry.created).toLocaleDateString(language==='zh'?'zh-CN':'en');const actions=document.createElement('div');actions.className='model-actions';const open=document.createElement('button');open.className='button small secondary';open.textContent=copy('查看与导出 ↗','Open & export ↗');open.disabled=busy;open.onclick=()=>{showView('scan');showModel(entry.model,entry.id);};const remove=document.createElement('button');remove.className='text-button';remove.textContent=copy('删除','Delete');remove.disabled=busy;remove.onclick=async()=>{if(!confirm(copy('从此浏览器永久删除这个本机模型？已导出的文件不会受影响。','Permanently delete this model from this browser? Exported files stay available.')))return;try{await deleteModel(entry.id);if(entry.id===modelId){modelSaved=false;modelId=null;sync();}renderLibrary();}catch{notify(copy('无法删除，请稍后重试。','Could not delete the model. Try again.'),true);}};actions.append(open,remove);info.append(h,p,actions);card.append(art,info);grid.append(card);}
}
const restart=document.createElement('button');restart.id='restartCamera';restart.className='button small secondary';restart.textContent='◉';restart.setAttribute('aria-label','开启摄像头 / Start camera');$('addPhotos').after(restart);
$('processingMessage').setAttribute('aria-live','polite');$('confirmDialog').querySelector('h3').id='clearDialogTitle';$('confirmDialog').querySelector('p').id='clearDialogDescription';$('confirmDialog').setAttribute('aria-labelledby','clearDialogTitle');$('confirmDialog').setAttribute('aria-describedby','clearDialogDescription');
$('language').onclick=()=>{language=language==='zh'?'en':'zh';try{localStorage.setItem('spatial-language',language);}catch{}applyLanguage();};
$('theme').onclick=()=>{theme=theme==='dark'?'light':'dark';try{localStorage.setItem('spatial-theme',theme);}catch{}applyTheme();};
for(const b of document.querySelectorAll('[data-view]'))b.onclick=()=>showView(b.dataset.view);
$('startCamera').onclick=startCamera;restart.onclick=startCamera;$('stopCamera').onclick=stopCamera;$('captureFrame').onclick=()=>takeFrame(false);
$('toggleAuto').onclick=()=>{if(autoTimer){stopAuto();return;}takeFrame(true);autoTimer=setInterval(()=>takeFrame(true),1500);$('toggleAuto').textContent=copy('停止采集','Stop auto');$('toggleAuto').classList.add('recording');};
for(const id of ['importPhotos','addPhotos'])$(id).onclick=()=>$('photoInput').click();
$('photoInput').onchange=async e=>{const files=Array.from(e.target.files);e.target.value='';await importFiles(files);};
$('clearFrames').onclick=()=>$('confirmDialog').showModal();$('keepFrames').onclick=()=>$('confirmDialog').close();$('confirmClear').onclick=()=>{$('confirmDialog').close();clearAll();};
$('prepareEngine').onclick=()=>prepareEngine();$('clearCache').onclick=async()=>{try{await engine.clearCache();engineReady=false;offlineCached=false;engineLabels();notify(copy('视觉引擎缓存已清除。下次使用需要重新下载。','Vision engine cache cleared. The next use needs a download.'));}catch(error){notify(error.message,true);}};
$('reconstruct').onclick=reconstruct;$('cancelReconstruction').onclick=()=>{activeReconstruction=null;engine.cancel();engineReady=false;busy=false;engineDownloading=false;$('processingOverlay').hidden=true;renderFrames();sync();engineLabels();notify(copy('重建已取消，已采集的视角仍保留。','Reconstruction cancelled. Your captured views are still available.'));};
$('resetView').onclick=()=>viewer?.reset();$('pointSize').oninput=e=>viewer?.setPointSize(Number(e.target.value));$('exportGLB').onclick=()=>exportModel('glb');$('exportPLY').onclick=()=>exportModel('ply');$('saveModel').onclick=saveCurrent;
window.addEventListener('online',engineLabels);window.addEventListener('offline',engineLabels);window.addEventListener('pagehide',()=>{stopCamera();});document.addEventListener('visibilitychange',()=>{if(document.hidden)stopAuto();});
const capabilityCanvas=document.createElement('canvas');const gl=capabilityCanvas.getContext('webgl2');$('renderBadge').textContent=gl?'WebGL2 / GPU':copy('预览不可用','NO WEBGL2');gl?.getExtension('WEBGL_lose_context')?.loseContext();
applyTheme();applyLanguage();showView('scan');updateLibraryCount();
async function boot(){if('serviceWorker'in navigator){try{await navigator.serviceWorker.register('./sw.js',{scope:'./'});await Promise.race([navigator.serviceWorker.ready,new Promise(resolve=>setTimeout(resolve,2500))]);shellCached=Boolean(navigator.serviceWorker.controller)&&Boolean(await caches.match(new URL('./app.js',location.href)));}catch{}}setTimeout(()=>prepareEngine({quiet:true}),500);}
boot();
