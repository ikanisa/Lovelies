/** Small portable SHA-256 state for bounded, restartable private-object writers.
 * The state is private data (its final block can contain plaintext). Never log it
 * or send it to clients. SHA-256 values, unlike this state, are public bindings. */
export type Sha256State = Readonly<{ version: 1; words: readonly number[]; tail: readonly number[]; bytes: number }>;
const initial = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const k = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
const rotate = (n: number, bits: number): number => (n >>> bits) | (n << (32 - bits));
export class IncrementalSha256 {
    private words: number[]; private tail: number[]; private length: number;
    constructor(state?: Sha256State) {
        if (state !== undefined && (state.version !== 1 || Object.keys(state).sort().join(',') !== 'bytes,tail,version,words' ||
            !Number.isSafeInteger(state.bytes) || state.bytes < 0 || !Array.isArray(state.words) || state.words.length !== 8 ||
            state.words.some(n => !Number.isInteger(n) || n < 0 || n > 0xffffffff) || !Array.isArray(state.tail) || state.tail.length !== state.bytes % 64 ||
            state.tail.some(n => !Number.isInteger(n) || n < 0 || n > 255))) throw new Error('sha256_state_invalid');
        this.words = [...(state?.words ?? initial)]; this.tail = [...(state?.tail ?? [])]; this.length = state?.bytes ?? 0;
    }
    private block(bytes: Uint8Array): void {
        const w = new Uint32Array(64), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(i * 4);
        for (let i = 16; i < 64; i++) {
            const x = w[i - 15], y = w[i - 2];
            w[i] = (w[i - 16] + (rotate(x,7)^rotate(x,18)^(x>>>3)) + w[i - 7] + (rotate(y,17)^rotate(y,19)^(y>>>10))) >>> 0;
        }
        let [a,b,c,d,e,f,g,h] = this.words;
        for (let i = 0; i < 64; i++) {
            const t1 = (h + (rotate(e,6)^rotate(e,11)^rotate(e,25)) + ((e&f)^(~e&g)) + k[i] + w[i]) >>> 0;
            const t2 = ((rotate(a,2)^rotate(a,13)^rotate(a,22)) + ((a&b)^(a&c)^(b&c))) >>> 0;
            h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
        }
        const work=[a,b,c,d,e,f,g,h]; for(let i=0;i<8;i++)this.words[i]=(this.words[i]+work[i])>>>0;
        w.fill(0); work.fill(0);
    }
    update(bytes: Uint8Array): this {
        if (!Number.isSafeInteger(this.length + bytes.byteLength)) throw new Error('sha256_length_invalid');
        this.length += bytes.byteLength; let index=0;
        if(this.tail.length){
            const take=Math.min(64-this.tail.length,bytes.length);for(;index<take;index++)this.tail.push(bytes[index]);
            if(this.tail.length===64){const block=new Uint8Array(this.tail);this.block(block);block.fill(0);this.tail.fill(0);this.tail=[];}
        }
        while(index+64<=bytes.length){this.block(bytes.subarray(index,index+64));index+=64;}
        for(;index<bytes.length;index++)this.tail.push(bytes[index]);return this;
    }
    state(): Sha256State { return {version:1,words:[...this.words],tail:[...this.tail],bytes:this.length}; }
    hex(): string {
        const clone=new IncrementalSha256(this.state()), padded=new Uint8Array(clone.tail.length<56?64:128);
        padded.set(clone.tail);padded[clone.tail.length]=0x80;
        const view=new DataView(padded.buffer), bits=BigInt(clone.length)*8n;
        view.setUint32(padded.length-8,Number((bits>>32n)&0xffffffffn));view.setUint32(padded.length-4,Number(bits&0xffffffffn));
        clone.block(padded.subarray(0,64));if(padded.length===128)clone.block(padded.subarray(64));
        const result=clone.words.map(n=>n.toString(16).padStart(8,'0')).join('');padded.fill(0);clone.clear();return result;
    }
    clear():void {this.words.fill(0);this.tail.fill(0);this.length=0;}
}
