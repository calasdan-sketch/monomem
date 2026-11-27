const D=768,N=10000;const m=new Float32Array(N*D).map(()=>Math.random()-.5),q=new Float32Array(D).map(()=>Math.random()-.5);
const s1=()=>{let t=0;for(let r=0;r<N;r++){const o=r*D;let d=0;for(let i=0;i<D;i++)d+=q[i]*m[o+i];t+=d}return t};
const s4=()=>{let t=0;for(let r=0;r<N;r++){const o=r*D;let a=0,b=0,c=0,e=0;for(let i=0;i<D;i+=4){a+=q[i]*m[o+i];b+=q[i+1]*m[o+i+1];c+=q[i+2]*m[o+i+2];e+=q[i+3]*m[o+i+3]}t+=a+b+c+e}return t};
for(const [n,f] of [["seq",s1],["x4",s4],["seq",s1],["x4",s4]]){const a=[];for(let k=0;k<9;k++){const t=performance.now();f();a.push(performance.now()-t)}a.sort((x,y)=>x-y);console.log(n,a[4].toFixed(1))}
