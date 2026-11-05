// Optional transfer encoding inside the encrypted channel. The phone acknowledges the exact snapshot it decoded;
// a lost reply, new page, different conversation or older client gets complete message text instead of a patch.
export const TRANSFER_ENCODING = 'text-append-v1';
const MAX_MESSAGES = 100, MAX_TEXT = 2 * 1024 * 1024;

export function conversationRoute(path) {
  if (typeof path !== 'string') return null;
  const url = new URL(path, 'https://phone.local');
  return url.pathname === '/api/conversation' ? JSON.stringify([url.searchParams.get('projectId'), url.searchParams.get('task')]) : null;
}
function snapshot(body, view, base, previous, compatible) {
  const texts = compatible ? new Map(previous.texts) : new Map();
  for (const message of body.messages) {
    if (typeof message.id !== 'string' || typeof message.text !== 'string') continue;
    texts.delete(message.id); texts.set(message.id, message.text);
  }
  let length = [...texts.values()].reduce((size, text) => size + text.length * 2, 0);
  for (const [id, text] of texts) {
    if (texts.size <= MAX_MESSAGES && length <= MAX_TEXT) break;
    texts.delete(id); length -= text.length * 2;
  }
  return { id: body.id, view, base, texts };
}
export function encodeConversation(body, view, base, previous, nextBase) {
  const compatible = body.delta && previous && previous.id === body.id && previous.view === view && previous.base === base;
  const messages = body.messages.map(message => {
    const text = compatible && previous.texts.get(message.id);
    if (typeof text !== 'string' || text.length < 128 || typeof message.text !== 'string' || !message.text.startsWith(text)) return message;
    const { text: complete, ...rest } = message;
    return { ...rest, textAppend: { from: text.length, value: complete.slice(text.length) } };
  });
  return { body: { ...body, messages }, state: snapshot(body, view, nextBase, previous, compatible) };
}
export function decodeConversation(body, view, base, previous, nextBase) {
  const compatible = body.delta && previous && previous.id === body.id && previous.view === view && previous.base === base;
  const messages = body.messages.map(message => {
    if (!message.textAppend) return message;
    const { textAppend, ...rest } = message, text = compatible && previous.texts.get(message.id);
    if (typeof text !== 'string' || text.length !== textAppend.from || typeof textAppend.value !== 'string') {
      throw Object.assign(Error('Refresh the conversation to restore its text.'), { code: 'PHONE_TEXT_BASE' });
    }
    return { ...rest, text: text + textAppend.value };
  });
  const decoded = { ...body, messages };
  return { body: decoded, state: snapshot(decoded, view, nextBase, previous, compatible) };
}
