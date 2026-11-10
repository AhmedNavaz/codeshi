// Portable deterministic public formats. No filesystem, network, or provider access.
export const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_BYTES = 256 * 1024;
// Binary files (#25) travel as base64, so a 1 MiB file takes about 1.4 MiB of the 2 MiB package.
export const MAX_BINARY_BYTES = 1024 * 1024;
// Text-only patches keep the original format, so older versions still read them. A patch
// with a binary file uses files.v1, which an older version refuses with a clear error.
export const PATCH_FORMAT = 'ai-relay.text.v1';
export const FILES_PATCH_FORMAT = 'ai-relay.files.v1';
export const PATCH_FORMATS = [PATCH_FORMAT, FILES_PATCH_FORMAT];
const encoder = new TextEncoder();
const hashPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const byteLength = value => encoder.encode(String(value)).length;
export function invalid(message, status = 400) { return Object.assign(new Error(message), { status }); }
function assert(condition, message) { if (!condition) throw invalid(message); }
export function canonicalStringify(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalStringify(value[key])).join(',') + '}';
  }
  throw invalid('Only finite JSON values are supported.');
}

// SHA-256 is synchronous and identical in Node and an isolated browser renderer.
// Text is hashed as its UTF-8 bytes, so a file's hash is the same whether it is sent as text or bytes.
export function sha256(value) {
  const input = value instanceof Uint8Array ? value : encoder.encode(String(value));
  const length = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(length); bytes.set(input); bytes[input.length] = 128;
  const view = new DataView(bytes.buffer);
  const bits = input.length * 8;
  view.setUint32(length - 8, Math.floor(bits / 0x100000000)); view.setUint32(length - 4, bits >>> 0);
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const r = (x,n) => (x >>> n) | (x << (32-n));
  const w = new Uint32Array(64);
  for (let offset = 0; offset < length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) { const a=w[i-15], b=w[i-2]; w[i]=(w[i-16]+(r(a,7)^r(a,18)^(a>>>3))+w[i-7]+(r(b,17)^r(b,19)^(b>>>10)))>>>0; }
    let [a,b,c,d,e,f,g,j] = h;
    for (let i = 0; i < 64; i++) { const t1=(j+(r(e,6)^r(e,11)^r(e,25))+((e&f)^(~e&g))+k[i]+w[i])>>>0; const t2=((r(a,2)^r(a,13)^r(a,22))+((a&b)^(a&c)^(b&c)))>>>0; j=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0; }
    [a,b,c,d,e,f,g,j].forEach((n,i)=>{h[i]=(h[i]+n)>>>0;});
  }
  return h.map(n=>n.toString(16).padStart(8,'0')).join('');
}

const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export function encodeBase64(bytes) {
  let raw = '';
  for (let index = 0; index < bytes.length; index += 0x8000) raw += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
  return btoa(raw);
}
// Standard padded base64 only, with one spelling per byte sequence, so the integrity hash names exactly one file.
export function decodeBase64(value) {
  assert(typeof value === 'string' && base64Pattern.test(value), 'Binary content must be standard base64.');
  const raw = atob(value), bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  assert(encodeBase64(bytes) === value, 'Binary content must be standard base64.');
  return bytes;
}
// A file is text when it has no NUL byte and is valid UTF-8; everything else is binary.
export function isTextBytes(bytes) {
  if (bytes.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal:true, ignoreBOM:true }).decode(bytes); return true; } catch { return false; }
}
// The exact bytes of a shared, patched or saved file, checked against the limits. Text must be sent as
// text: base64 has no diff to review, so text sent that way could hide a change from the person applying it.
export function fileBytes(file, where = file?.path || 'file') {
  if (file.encoding === undefined) { text(file.content, where, MAX_FILE_BYTES); return encoder.encode(file.content); }
  assert(file.encoding === 'base64', 'Unsupported file encoding: ' + where);
  const bytes = decodeBase64(file.content);
  assert(bytes.length <= MAX_BINARY_BYTES, 'Binary files are limited to 1 MiB: ' + where);
  assert(!isTextBytes(bytes), 'Text files must be sent as text, not base64: ' + where);
  return bytes;
}

export function validateRelativePath(value) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 1024, 'File paths must be nonempty relative paths.');
  assert(!/[\\\x00-\x1f\x7f:]/.test(value) && !value.startsWith('/') && !value.startsWith('~') && !/%(?:2e|2f|5c)/i.test(value), 'Unsafe file path: ' + value);
  const parts = value.split('/');
  assert(parts.every(part => part && part !== '.' && part !== '..'), 'Path traversal is not supported: ' + value);
  const denied = /^(?:\.git|\.data|\.ai-relay|\.codex|\.claude|\.gemini|\.aws|\.ssh|\.gnupg|node_modules|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|sessions?(?:\..*)?|auth(?:\.json)?|\.npmrc|\.netrc)$/i;
  assert(!parts.some(part => denied.test(part) || /\.(?:pem|key|p12|pfx|keystore)$/i.test(part)), 'Private, credential, provider-session, or runtime paths cannot be shared: ' + value);
  return value;
}
function keys(value, allowed, where) {
  assert(value && typeof value === 'object' && !Array.isArray(value), where + ' must be an object.');
  assert(Object.keys(value).every(key => allowed.includes(key)), 'Unsupported field in ' + where + '.');
}
function text(value, where, max = 64000) { assert(typeof value === 'string' && byteLength(value) <= max && !value.includes('\u0000') && new TextDecoder('utf-8', {ignoreBOM:true}).decode(encoder.encode(value)) === value, where + ' must be supported UTF-8 text.'); }
function list(value, where, max = 200) { assert(Array.isArray(value) && value.length <= max, where + ' must be a bounded array.'); }
function texts(value, where) { list(value, where); value.forEach((entry,i) => text(entry, where+'['+i+']',16000)); }
function identity(value, schema) {
  assert(value.schema === schema && value.version === 1, 'Unsupported package schema or version.');
  assert(typeof value.id === 'string' && uuidPattern.test(value.id), 'A UUID package ID is required.');
  assert(typeof value.createdAt === 'string' && /^\d{4}-\d\d-\d\dT/.test(value.createdAt) && Number.isFinite(Date.parse(value.createdAt)), 'A valid creation time is required.');
}
function boundedClone(value) {
  let encoded;
  try { encoded = canonicalStringify(value); } catch (error) { throw invalid(error.message); }
  assert(byteLength(encoded) <= MAX_PACKAGE_BYTES, 'Packages must not exceed 2 MiB.');
  return JSON.parse(encoded);
}
function integrityFor(value) { const { integrity, ...body } = value; return sha256(canonicalStringify(body)); }
function checkIntegrity(value) { assert(hashPattern.test(value.integrity || '') && integrityFor(value) === value.integrity, 'Package integrity does not match its exact contents.'); }
function hashOrNull(value) { return value === null || typeof value === 'string' && hashPattern.test(value); }
export function buildInventory(value) {
  const fields = ['goal','problem','expectedOutcome','decisions','tasks'].map(name => ({ name, bytes: byteLength(canonicalStringify(value[name])), sha256: sha256(canonicalStringify(value[name])) }));
  if(value.folderLayout)fields.push({name:'folderLayout',bytes:byteLength(canonicalStringify(value.folderLayout)),sha256:sha256(canonicalStringify(value.folderLayout))});
  return { fields, messages: value.messages.map((m,index) => ({ index, role:m.role, bytes:byteLength(canonicalStringify(m)), sha256:sha256(canonicalStringify(m)) })),
    files: value.files.map(f => ({ path:f.path, bytes:f.encoding === undefined ? byteLength(f.content) : fileBytes(f).length, sha256:f.sha256 })), baseline:value.baseline.map(f=>({path:f.path,sha256:f.sha256})) };
}
export function sealPackage(value) {
  const { integrity, inventory, ...body } = value;
  const result = { ...body, inventory: buildInventory(body) };
  result.integrity = integrityFor(result);
  return validatePublicPackage(result);
}
export function sealSolution(value) {
  const { integrity, ...body } = value;
  return validateSolution({ ...body, integrity:integrityFor(body) });
}
export function validatePublicPackage(input) {
  const value = boundedClone(input);
  keys(value,['schema','version','id','createdAt','mode','goal','problem','expectedOutcome','decisions','tasks','messages','files','baseline','folderLayout','inventory','integrity'],'handoff');
  identity(value,'ai-relay.handoff');
  assert(['context','source'].includes(value.mode),'Choose context-only or selected-source sharing.');
  ['goal','problem','expectedOutcome'].forEach(field=>text(value[field],field)); texts(value.decisions,'decisions'); texts(value.tasks,'tasks');
  list(value.messages,'messages',500);
  value.messages.forEach((m,i)=>{keys(m,['role','text','provider'],'message');assert(['user','assistant','activity','error','system'].includes(m.role),'Unsupported message role.');text(m.text,'message '+i,MAX_FILE_BYTES);if(m.provider!==undefined)assert(['codex','claude','gemini'].includes(m.provider),'Unsupported message provider.');});
  list(value.files,'files',128); list(value.baseline,'baseline',128);
  if(value.folderLayout!==undefined){
    keys(value.folderLayout,['style','folders'],'folder layout');assert(value.folderLayout.style==='namespaced','Unsupported folder layout.');list(value.folderLayout.folders,'folder aliases',128);assert(value.folderLayout.folders.length>0,'Declare a shared folder alias.');
    for(const name of value.folderLayout.folders){text(name,'folder alias',120);validateRelativePath(name);assert(!name.includes('/'),'Folder aliases cannot contain slashes.');}
    assert(new Set(value.folderLayout.folders).size===value.folderLayout.folders.length,'Folder aliases must be unique.');
    for(const file of value.baseline)assert(value.folderLayout.folders.includes(file.path.split('/')[0])&&file.path.includes('/'),'Baseline path does not match its folder layout.');
  }
  const baselines=new Map();
  value.baseline.forEach(f=>{keys(f,['path','sha256'],'baseline');validateRelativePath(f.path);assert(!baselines.has(f.path),'Duplicate baseline path.');assert(hashOrNull(f.sha256),'Invalid baseline hash.');baselines.set(f.path,f.sha256);});
  const seen=new Set();
  value.files.forEach(f=>{keys(f,['path','content','sha256','encoding'],'source file');validateRelativePath(f.path);assert(!seen.has(f.path),'Duplicate source path.');seen.add(f.path);assert(typeof f.content==='string',f.path+' must have content.');assert(sha256(fileBytes(f))===f.sha256,'Source file hash does not match: '+f.path);assert(baselines.get(f.path)===f.sha256,'Approved source and baseline must match: '+f.path);});
  assert(value.mode==='source'||!value.files.length,'Context-only packages cannot contain source files.');
  assert(canonicalStringify(value.inventory)===canonicalStringify(buildInventory(value)),'The inventory must describe the exact approved package.');
  checkIntegrity(value);
  return value;
}
export const validateHandoff = validatePublicPackage;
export function validateSolution(input, { handoffId } = {}) {
  const value=boundedClone(input);
  keys(value,['schema','version','id','handoffId','createdAt','explanation','assumptions','verification','patch','integrity'],'solution'); identity(value,'ai-relay.solution');
  assert(typeof value.handoffId==='string' && uuidPattern.test(value.handoffId),'A valid handoff ID is required.');
  if(handoffId)assert(value.handoffId===handoffId,'Solution belongs to a different handoff.');
  text(value.explanation,'explanation');texts(value.assumptions,'assumptions');texts(value.verification,'contributor-reported verification');
  keys(value.patch,['format','files'],'patch');assert(PATCH_FORMATS.includes(value.patch.format),'Only ai-relay.text.v1 and ai-relay.files.v1 full-file patches are supported.');list(value.patch.files,'patch files',128);
  const seen=new Set();value.patch.files.forEach(f=>{keys(f,['path','baseHash','content','encoding'],'patch file');validateRelativePath(f.path);assert(!seen.has(f.path),'Duplicate patch path.');seen.add(f.path);assert(hashOrNull(f.baseHash),'Invalid patch baseline hash.');assert(f.content===null||typeof f.content==='string','Patch content must be text, base64 bytes, or null for deletion.');
    if(f.encoding!==undefined)assert(value.patch.format===FILES_PATCH_FORMAT&&f.content!==null,'Binary content needs the ai-relay.files.v1 format: '+f.path);
    if(f.content!==null)fileBytes(f);assert(f.baseHash!==null||f.content!==null,'Deleting an absent file is unsupported.');});
  checkIntegrity(value);return value;
}

const detectors = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['credential', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['credential', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g],
  ['credential', /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|authorization)\s*[:=]\s*["']?(?:Bearer\s+)?[A-Za-z0-9_./+=-]{16,}/gi],
  ['absolute-path', /(?:\/(?:Users|home|private|tmp|var\/folders)\/[^\s"'<>]+|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\r\n"'<>]+)/g],
];
export function scanSecrets(value) {
  const warnings=[];
  function walk(item, location) {
    // A binary file's readable strings are scanned, not its base64, which would only match by chance.
    if(item&&typeof item==='object'&&item.encoding==='base64'&&typeof item.content==='string'){
      let readable='';try{const bytes=decodeBase64(item.content);for(let index=0;index<bytes.length;index+=0x8000)readable+=String.fromCharCode.apply(null,bytes.subarray(index,index+0x8000));}catch{}
      walk(readable,location?location+'.content':'content');
      Object.entries(item).forEach(([key,entry])=>{if(!['integrity','sha256','baseHash','content'].includes(key))walk(entry,location?location+'.'+key:key);});
      return;
    }
    if(typeof item==='string')for(const [code,pattern] of detectors){pattern.lastIndex=0;if(pattern.test(item))warnings.push({code,location,message:code==='absolute-path'?'A machine-specific absolute path needs review.':'Possible secret material needs removal or review.'});}
    else if(Array.isArray(item))item.forEach((entry,index)=>walk(entry,location+'['+index+']'));
    else if(item&&typeof item==='object')Object.entries(item).forEach(([key,entry])=>{if(!['integrity','sha256','baseHash'].includes(key))walk(entry,location?location+'.'+key:key);});
  }
  walk(value,'');return warnings;
}
export function redactPublicText(value, workspace = '') {
  let result=String(value??'');
  if(workspace)result=result.split(workspace).join('[project]');
  for(const [code,pattern]of detectors){pattern.lastIndex=0;result=result.replace(pattern,code==='absolute-path'?'[local path removed]':'[possible secret removed]');}
  return result;
}
