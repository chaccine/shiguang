/** Browser preview only: WebCrypto PBKDF2, NOT the native Argon2id verifier.
 * Preview storage/backup envelopes are not interchangeable with native state.
 * This simulates the UI gate contract using synthetic data; real Tauri always
 * invokes Rust Argon2id. No passcode is persisted or included in diagnostics.
 */
export interface PreviewLock {
  algorithm: "pbkdf2-sha256-preview";
  iterations: 100000;
  salt: string;
  hash: string;
  failures: number;
  blockedUntilMs: number;
}
export function validPreviewLock(v: unknown): v is PreviewLock {
  if (!v || typeof v !== "object") return false;
  const x=v as PreviewLock;
  return x.algorithm==="pbkdf2-sha256-preview" && x.iterations===100000
    && typeof x.salt==="string" && x.salt.length===32 && /^[a-f0-9]{32}$/.test(x.salt)
    && typeof x.hash==="string" && x.hash.length===64 && /^[a-f0-9]{64}$/.test(x.hash)
    && Number.isInteger(x.failures) && x.failures>=0 && x.failures<=0xffffffff
    && Number.isSafeInteger(x.blockedUntilMs) && x.blockedUntilMs>=0 && (x.failures>=3 || x.blockedUntilMs===0);
}
export function validPasscode(value: string): boolean {
  return typeof value==="string" && value.length>=4 && value.length<=8 && !/[^0-9]/.test(value);
}
export function backoffMs(failures: number): number { return failures<3 ? 0 : Math.min(1000*2**Math.min(failures-3,12),3_600_000); }
function hex(bytes: Uint8Array): string { return Array.from(bytes,(v)=>v.toString(16).padStart(2,"0")).join(""); }
function unhex(text: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(text.match(/../g)!, (v)=>parseInt(v,16)); }
function cryptoFailed(): never { throw { code:"APP_LOCK_CRYPTO_FAILED",message:"应用锁操作未完成，请重试" }; }
async function derive(passcode:string,salt:string):Promise<Uint8Array<ArrayBuffer>> {
  const raw=new TextEncoder().encode(passcode);
  try {
    const key=await globalThis.crypto.subtle.importKey("raw",raw,"PBKDF2",false,["deriveBits"]);
    return new Uint8Array(await globalThis.crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",iterations:100000,salt:unhex(salt)},key,256));
  } catch { return cryptoFailed(); }
  finally { raw.fill(0); }
}
export async function newPreviewLock(passcode:string):Promise<PreviewLock> {
  if (!validPasscode(passcode)) throw {code:"APP_LOCK_CODE_INVALID",message:"应用锁密码须为 4–8 位数字"};
  let salt:string;
  try { salt=hex(globalThis.crypto.getRandomValues(new Uint8Array(16))); } catch { return cryptoFailed(); }
  const derived=await derive(passcode,salt);
  try { return {algorithm:"pbkdf2-sha256-preview",iterations:100000,salt,hash:hex(derived),failures:0,blockedUntilMs:0}; }
  finally { derived.fill(0); }
}
export async function verifyPreviewLock(passcode:string,lock:PreviewLock):Promise<boolean> {
  if (!validPasscode(passcode)) return false;
  const derived=await derive(passcode,lock.salt),expected=unhex(lock.hash);
  try { let difference=0; for(let i=0;i<32;i++) difference|=derived[i]!^expected[i]!; return difference===0; }
  finally { derived.fill(0);expected.fill(0); }
}
