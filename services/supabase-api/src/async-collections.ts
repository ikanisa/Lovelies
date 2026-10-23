/** Sequential iteration preserves transaction order on its reserved connection. */
export async function asyncMap<T,U>(items: readonly T[], callback: (item:T,index:number)=>U|Promise<U>):Promise<U[]> {
  const out:U[]=[]; for(let i=0;i<items.length;i++)out.push(await callback(items[i],i));return out;
}
export async function asyncFilter<T>(items: readonly T[], callback:(item:T,index:number)=>unknown|Promise<unknown>):Promise<T[]> {
  const out:T[]=[];for(let i=0;i<items.length;i++)if(await callback(items[i],i))out.push(items[i]);return out;
}
export async function asyncSome<T>(items: readonly T[], callback:(item:T,index:number)=>unknown|Promise<unknown>):Promise<boolean> {
  for(let i=0;i<items.length;i++)if(await callback(items[i],i))return true;return false;
}
export async function asyncEvery<T>(items: readonly T[], callback:(item:T,index:number)=>unknown|Promise<unknown>):Promise<boolean> {
  for(let i=0;i<items.length;i++)if(!await callback(items[i],i))return false;return true;
}
export async function asyncFind<T>(items: readonly T[], callback:(item:T,index:number)=>unknown|Promise<unknown>):Promise<T|undefined> {
  for(let i=0;i<items.length;i++)if(await callback(items[i],i))return items[i];return undefined;
}
export async function asyncForEach<T>(items: readonly T[], callback:(item:T,index:number)=>unknown|Promise<unknown>):Promise<void> {
  for(let i=0;i<items.length;i++)await callback(items[i],i);
}
