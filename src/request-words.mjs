// The telling words of a request (#85), for finding the older decisions and the files it comes back to. Local rules,
// no model: common words are dropped and word endings folded, so "rated", "rating" and "rates" are one word.
const COMMON = new Set(('the and for with that this these those from what which when where have has had did does done was were are be been being you your yours our ours they them their there here then than into onto over under about after before again also only just still very more most much many some any each every both all not but can could should would will shall may might must make made use used using need needs want wanted like said say says tell told ask asked answer answered decide decided decision choose chose chosen pick picked question questions earlier later now today thing things way one two three how why who whose its let lets get got give given take took keep kept work works working change changes changed file files code add added remove removed new old same other another yes yeah okay please thanks recommended set sets setting via per instead rather even well back first last next while because since until unless whether either neither none nothing something anything everything').split(' '));

export const stem = word => {
  let value = word;
  for (let round = 0; round < 2; round++) for (const ending of ['ing', 'ed', 'es', 's']) if (value.length - ending.length >= 3 && value.endsWith(ending) && !value.endsWith('ss')) { value = value.slice(0, -ending.length); break; }
  return value.length > 3 && value.endsWith('e') ? value.slice(0, -1) : value;
};

export function significantWords(text) {
  const words = new Set();
  for (const raw of String(text || '').toLowerCase().match(/#\d+|[\p{L}\p{N}]+/gu) || []) {
    if (raw.startsWith('#')) { words.add(raw); continue; }
    if (raw.length < 3 || /^\d+$/.test(raw) || COMMON.has(raw)) continue;
    const word = stem(raw);
    if (!COMMON.has(word)) words.add(word);
  }
  return words;
}

// Words the request writes with a capital inside a sentence, as names are: Argon, Haseeb, Stripe.
export const namedWords = text => new Set(String(text || '').split(/[.!?:\n]+/).flatMap(sentence => (sentence.match(/[\p{L}\p{N}]+/gu) || []).slice(1)).filter(word => /^\p{Lu}/u.test(word) && word.length >= 3).map(word => stem(word.toLowerCase())));

// The words a file name could be written as in a request: its telling words, and each two neighbouring words run
// together, since "Sign in" is signin in github-signin.mjs.
export function fileNameWords(text) {
  const words = significantWords(text), plain = String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  for (let index = 1; index < plain.length; index++) if (plain[index - 1].length + plain[index].length >= 5) words.add(stem(plain[index - 1] + plain[index]));
  return words;
}
