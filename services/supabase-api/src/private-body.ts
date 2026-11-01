import { ApiError } from './types.ts';

/** Exact-sized private Storage body. Metadata is not a stream length bound;
 * retain one destination and stop on oversize, fragmentation, abort or timeout. */
export async function readPrivateBytes(stream: ReadableStream<Uint8Array> | null, expected: number, maximum: number, signal?: AbortSignal): Promise<Uint8Array> {
    const invalid=():never=>{throw new ApiError(503,'private_object_unverified');};
    if(!stream||!Number.isSafeInteger(expected)||expected<1||expected>maximum)return invalid();
    const bytes=new Uint8Array(expected),reader=stream.getReader();let offset=0,fragments=0,empty=0,complete=false;
    let timer:ReturnType<typeof setTimeout>|undefined,onAbort:(()=>void)|undefined;
    const interrupted=new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(new ApiError(503,'private_object_read_timeout')),30000);
        onAbort=()=>reject(new ApiError(503,'private_object_read_cancelled'));
        signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
    });
    // Keep the rejection handled even if a synchronous read fails first.
    void interrupted.catch(()=>{});
    try{
        for(;;){
            const next=await Promise.race([reader.read(),interrupted]);
            if(signal?.aborted)throw new ApiError(503,'private_object_read_cancelled');
            if(next.done)break;
            if(!(next.value instanceof Uint8Array)||++fragments>4096)return invalid();
            empty=next.value.byteLength===0?empty+1:0;
            if(empty>16||next.value.byteLength>expected-offset)return invalid();
            bytes.set(next.value,offset);offset+=next.value.byteLength;
        }
        if(offset!==expected)return invalid();complete=true;return bytes;
    }finally{
        if(timer!==undefined)clearTimeout(timer);if(onAbort)signal?.removeEventListener('abort',onAbort);
        if(!complete)bytes.fill(0);
        try{void reader.cancel().catch(()=>{});}catch{}
        try{reader.releaseLock();}catch{}
    }
}
