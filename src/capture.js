/** Photos remain local. Store compressed frames; decode pixels only when needed. */
export class CaptureSet {
  constructor({limit=32,maxEdge=900}={}){this.limit=limit;this.maxEdge=maxEdge;this.frames=[];this.width=0;this.height=0;this.fingerprint=null;}
  async add(source,{automatic=false}={}){
    if(this.frames.length>=this.limit)throw Object.assign(new Error('frame-limit'),{code:'limit'});
    const width=source.videoWidth||source.naturalWidth||source.width,height=source.videoHeight||source.naturalHeight||source.height;
    if(!width||!height)throw Object.assign(new Error('image-not-ready'),{code:'decode'});
    if(this.width&&Math.abs(width/height-this.width/this.height)>.025)throw Object.assign(new Error('same-orientation-required'),{code:'aspect'});
    let w=this.width,h=this.height;
    if(!w){const scale=Math.min(1,this.maxEdge/Math.max(width,height));w=Math.round(width*scale);h=Math.round(height*scale);}
    const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(source,0,0,w,h);
    const small=document.createElement('canvas');small.width=96;small.height=72;
    const sc=small.getContext('2d',{willReadFrequently:true});sc.drawImage(canvas,0,0,96,72);
    const rgba=sc.getImageData(0,0,96,72).data,g=new Float32Array(96*72);
    for(let i=0;i<g.length;i++)g[i]=(rgba[i*4]+rgba[i*4+1]*2+rgba[i*4+2])/4;
    let sharp=0,difference=0,count=0;
    for(let y=1;y<71;y++)for(let x=1;x<95;x++){const i=y*96+x,v=4*g[i]-g[i-1]-g[i+1]-g[i-96]-g[i+96];sharp+=v*v;count++;}
    sharp/=count;
    if(this.fingerprint)for(let i=0;i<g.length;i++)difference+=Math.abs(g[i]-this.fingerprint[i])/g.length;
    if(automatic&&sharp<35)return {skipped:'blur'};
    if(automatic&&this.fingerprint&&difference<5)return {skipped:'motion'};
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.94));
    if(!blob)throw Object.assign(new Error('image-decode-failed'),{code:'decode'});
    this.width=w;this.height=h;this.fingerprint=g;
    const frame={blob,url:URL.createObjectURL(blob),width:w,height:h,sharpness:sharp};
    this.frames.push(frame);return frame;
  }
  async addFile(file){
    if(file.size>35*1024*1024)throw Object.assign(new Error('file-too-large'),{code:'size'});
    const bitmap=await decode(file);try{return await this.add(bitmap);}finally{bitmap.close?.();if(bitmap._url)URL.revokeObjectURL(bitmap._url);}
  }
  remove(index){const [frame]=this.frames.splice(index,1);if(frame)URL.revokeObjectURL(frame.url);this.fingerprint=null;if(!this.frames.length){this.width=0;this.height=0;}}
  clear(){for(const f of this.frames)URL.revokeObjectURL(f.url);this.frames=[];this.width=0;this.height=0;this.fingerprint=null;}
  async pixels(isCurrent=()=>true){
    const frames=[];
    for(const f of this.frames){if(!isCurrent())throw new DOMException('Cancelled','AbortError');const bitmap=await decode(f.blob);try{if(!isCurrent())throw new DOMException('Cancelled','AbortError');const c=document.createElement('canvas');c.width=f.width;c.height=f.height;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0);frames.push({width:f.width,height:f.height,rgba:ctx.getImageData(0,0,f.width,f.height).data});}finally{bitmap.close?.();if(bitmap._url)URL.revokeObjectURL(bitmap._url);}}
    return frames;
  }
}
async function decode(blob){
  if(typeof createImageBitmap==='function'){try{return await createImageBitmap(blob);}catch{}}
  const url=URL.createObjectURL(blob);const image=new Image();image._url=url;
  try{await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=url;});return image;}catch{URL.revokeObjectURL(url);throw Object.assign(new Error('image-format-unsupported'),{code:'decode'});}
}
