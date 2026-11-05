import fs from 'node:fs';
import { continuationRequest } from './context.mjs';
import { resolveBinary } from './resolve-binary.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status, category: 'installation' });
export function localEndpoint(value = process.env.AI_RELAY_OLLAMA_URL || 'http://127.0.0.1:11434') {
  let url; try { url = new URL(value); } catch { throw fail('Choose a valid local Ollama address.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('Local models require an HTTP loopback address without a path or credentials.');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.origin;
}
async function read(endpoint, pathname, body, fetchImpl = fetch) {
  let response;
  try { response = await fetchImpl(endpoint + pathname, { method: body ? 'POST' : 'GET', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(4000) }); }
  catch { throw fail('Ollama is not responding. Start Ollama on this computer, then refresh local models.', 503); }
  if (!response.ok) throw fail('Ollama could not read the model details. Refresh local models and try again.', 503);
  let text = ''; const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length > 2 * 1024 * 1024) throw fail('Ollama returned oversized model metadata.', 502);
  }
  try { return JSON.parse(text + decoder.decode()); } catch { throw fail('Ollama returned invalid model metadata.', 502); }
}
function localModel(row, info) {
  if (typeof row?.name !== 'string' || !row.name || row.name.length > 200 || !/^[a-f\d]{64}$/i.test(row.digest || '')) return null;
  if (/(?:^|[-:])cloud(?:$|[-:])/i.test(row.name) || row.remote_host || row.remote_model || info?.remote_host || info?.remote_model || info?.details?.remote_host) return null;
  if (info?.details?.format !== 'gguf' || !info.model_info || typeof info.model_info['general.architecture'] !== 'string' || !Array.isArray(info.capabilities) || !info.capabilities.includes('tools') || !(row.size > 1024 * 1024)) return null;
  const architecture = info.model_info['general.architecture'], contextWindow = info.model_info[architecture + '.context_length'];
  return { id: row.name, model: row.name, digest: row.digest, parameterSize: info.details.parameter_size || null, contextWindow: Number.isSafeInteger(contextWindow) && contextWindow > 0 ? contextWindow : null, vision: info.capabilities.includes('vision') };
}
export async function localCatalog({ endpoint = localEndpoint(), fetchImpl = fetch, bin = resolveBinary('codex') } = {}) {
  endpoint = localEndpoint(endpoint);
  let installed = false; try { fs.accessSync(bin, fs.constants.X_OK); installed = true; } catch {}
  const tags = await read(endpoint, '/api/tags', null, fetchImpl);
  if (!Array.isArray(tags.models) || tags.models.length > 2000) throw fail('Ollama returned an invalid model list.', 502);
  const models = [], candidates = tags.models.slice(0, 100), deadline = Date.now() + 8000; let cursor = 0;
  // Bound metadata concurrency without loading or downloading a model.
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < candidates.length && Date.now() < deadline) {
      const row = candidates[cursor++]; if (typeof row?.name !== 'string' || row.name.length > 200 || !/^[a-f\d]{64}$/i.test(row.digest || '')) continue;
      try { const info = await read(endpoint, '/api/show', { model: row.name, verbose: false }, fetchImpl), model = localModel(row, info); if (model) models.push(model); } catch {}
    }
  }));
  models.sort((a, b) => a.id.localeCompare(b.id));
  return { endpoint, installed, models, billingSource: 'local', excluded: tags.models.length - models.length };
}
export function validateLocalSelection(model, digest) {
  if (typeof model !== 'string' || !model.trim() || model.length > 200 || typeof digest !== 'string' || !/^[a-f\d]{64}$/i.test(digest)) throw fail('Choose a downloaded local model from the refreshed list.');
  return { model, digest };
}
export async function verifyLocalModel(model, digest, { endpoint = localEndpoint(), fetchImpl = fetch } = {}) {
  validateLocalSelection(model, digest); endpoint = localEndpoint(endpoint);
  const tags = await read(endpoint, '/api/tags', null, fetchImpl);
  if (!Array.isArray(tags.models) || tags.models.length > 2000) throw fail('Ollama returned an invalid model list.', 502);
  const row = tags.models.find(item => item.name === model);
  if (!row || row.digest !== digest) throw fail('The selected local model changed or was removed. Refresh local models before continuing.', 409);
  const info = await read(endpoint, '/api/show', { model, verbose: false }, fetchImpl), verified = localModel(row, info);
  if (!verified) throw fail('This model is not a verified downloaded, tool-capable local model. Cloud models are unavailable in Continue locally.', 409);
  return { ...verified, endpoint };
}

export function createLocalRoutes({ registry, body, json, catalog = localCatalog, verify = verifyLocalModel }) {
  return async ({ req, res, url }) => {
    if (!url.pathname.startsWith('/api/local-models')) return false;
    if (url.pathname === '/api/local-models' && req.method === 'GET') {
      const result = await catalog({ bin: resolveBinary('codex', { override: registry.bins.codex }) }), projectId = url.searchParams.get('projectId');
      if (projectId) { const broker = registry.broker(projectId), c = broker.get(registry.mainConversation(projectId).id); result.context = { conversationId: c.id, workspaceSignature: broker.workspaceSignature, mode: c.mode }; }
      json(res, 200, result); return true;
    }
    if (url.pathname !== '/api/local-models/start' || req.method !== 'POST') throw fail('Use GET for local models or POST to start a local run.', 405);
    const projectId = url.searchParams.get('projectId'); if (!projectId) throw fail('Choose a workspace before continuing locally.');
    const input = await body(req), broker = registry.broker(projectId), conversation = broker.get(registry.mainConversation(projectId).id);
    if (input.context?.conversationId !== conversation.id || input.context?.workspaceSignature !== broker.workspaceSignature || input.context?.mode !== conversation.mode) throw fail('The workspace or access mode changed. Reopen Continue locally before starting.', 409);
    const local = validateLocalSelection(input.model, input.digest);
    json(res, 202, broker.start(conversation, { text: input.continuing === true ? continuationRequest : input.task, attachments: input.attachments || [], requestId: input.requestId }, { local, verifyLocal: () => verify(local.model, local.digest) }));
    return true;
  };
}
