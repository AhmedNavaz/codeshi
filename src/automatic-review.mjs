import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { captureReview, listReviewChanges, reviewLimits } from './agent-review.mjs';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const automaticReviewContextDigest = c => hash(c.context || {});
const scope = 'All reviewable uncommitted text changes in the selected repositories after this run, including changes already present before it starts. One read-only review; fixes require your selection and a separate Send.';
function folderSignature(folders) {
  try { return hash(folders.map(folder => [folder.id, fs.realpathSync(folder.path)])); }
  catch { fail('A workspace folder is unavailable. Reconnect it before preparing automatic review.', 409); }
}
function selectedFolders(folders, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > folders.length || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) fail('Choose each review repository once.');
  if (ids.some(id => !folders.some(folder => folder.id === id))) fail('A review folder is no longer attached to this workspace.', 409);
  return folders.filter(folder => ids.includes(folder.id));
}
function repositories(folders) {
  const repos = listReviewChanges(folders);
  const missing = repos.find(repo => !repo.available || repo.error);
  if (missing) fail(`${missing.name}: ${missing.error || 'This folder cannot be reviewed.'}`, 409);
  return repos;
}

// Authorization describes a single prompt and a future scope rule. File bytes are captured only once that prompt
// finishes. Binding the full task, pairing and roots means editing any of them asks again.
export function automaticReviewPlan(broker, c, { text, provider = c.provider, model = provider === c.provider ? c.model : c.models?.[provider] || null, mode = c.mode, approvalPolicy = c.approvalPolicy || 'ask', folderIds, attachments = [] } = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > 100000) fail('Write the task before enabling automatic review.');
  if (!['codex', 'claude', 'gemini'].includes(provider)) fail('Choose a supported builder before enabling automatic review.');
  if (mode !== 'edit') fail('Automatic review is available for coding runs. Use a manual review in read-only mode.');
  if (!['ask', 'auto'].includes(approvalPolicy)) fail('Choose a supported approval policy.');
  if (model !== null && (typeof model !== 'string' || model.length > 200)) fail('Choose a supported builder model.');
  if (!Array.isArray(attachments) || attachments.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) fail('Choose attachments saved in this workspace.');
  if (attachments.length && !broker.attachments) fail('Attachments are unavailable for this workspace.', 409);
  // Attachment IDs bind both filename and immutable contents. select() verifies their stored bytes and normal limits.
  const attachmentIds = broker.attachments ? broker.attachments.select(attachments).map(file => file.id) : [];
  const folders = selectedFolders(broker.workspaceFolders, folderIds);
  repositories(folders);
  const reviewer = provider === 'claude' ? 'codex' : 'claude';
  const plan = { builder: provider, builderModel: model || null, reviewer, model: c.models?.[reviewer] || null,
    folderIds: folders.map(folder => folder.id), folders: folders.map(folder => ({ id: folder.id, name: folder.displayName || folder.name, path: folder.path })),
    workspaceSignature: broker.workspaceSignature, folderSignature: folderSignature(broker.workspaceFolders), contextDigest: automaticReviewContextDigest(c), attachments: attachmentIds,
    goal: text.trim(), limits: { ...reviewLimits }, scope };
  return { ...plan, approvedDigest: hash({ ...plan, text: text.trim(), mode, approvalPolicy }) };
}

// No client-supplied provider, model or scope label is used to launch the reviewer. Rebuild from current settings,
// then compare its digest with the one shown before Send. API billing approval remains a separate boolean.
export function validateAutomaticReview(broker, c, input, runSelection) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Preview automatic review before sending.');
  if (typeof input.approvedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.approvedDigest)) fail('Preview automatic review before sending.');
  if (input.billingConfirmed !== undefined && typeof input.billingConfirmed !== 'boolean') fail('Confirm reviewer billing explicitly.');
  const plan = automaticReviewPlan(broker, c, { ...runSelection, folderIds: input.folderIds });
  if (plan.approvedDigest !== input.approvedDigest || input.reviewer !== plan.reviewer || input.model !== plan.model) fail('The task, agents or review scope changed. Preview automatic review again.', 409);
  return { ...plan, billingConfirmed: input.billingConfirmed === true };
}

// Unsupported files are explicitly outside the authorized text scope. Unexpected capture failures and budget limits
// stop the handoff; taking the first twelve files would make a partial review look like a completed one.
const excluded = error => error.status === 400 && /^(?:Binary files cannot be included in a review\.|Symbolic links cannot be included in a review\.|Choose individual text files, not folders or submodules\.|Choose a changed text file; binary files, submodules and symbolic links are not supported\.)$/.test(error.message);
export function captureAutomaticReview(plan, folders) {
  if (plan.folderSignature !== folderSignature(folders)) fail('Workspace folders changed. Authorize a new automatic review.', 409);
  const repos = repositories(selectedFolders(folders, plan.folderIds)), selections = [];
  if (repos.some(repo => repo.changesClipped)) fail('Too many changed files to capture automatic review completely. Select a manual review scope.', 413);
  for (const repo of repos) for (const file of repo.changes) {
    if (file.reason) continue;
    const selection = { folderId: repo.folderId, path: file.path };
    try { captureReview(folders, [selection]); }
    catch (error) { if (excluded(error)) continue; throw error; }
    selections.push(selection);
    if (selections.length > reviewLimits.files) fail('Automatic review exceeds the 12-file limit. Select a manual review scope.', 413);
  }
  return selections.length ? captureReview(folders, selections) : null;
}
