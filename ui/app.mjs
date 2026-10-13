import { watchAppTheme } from './theme.mjs';
import { renderDependencyDiagrams } from './dependencies.mjs';
import { diagnosticMarkers } from './diagnostics.mjs';
import { pathChange } from './path-changes.mjs';
const $ = id => document.getElementById(id);
let config, prs = [], review, current, diff, models = [], navigation = 0, reviewNavigation = 0, controller, selection;
let monacoLoaded = false, workerVerified = false, workerError = '', activeSide = 'right';
const modelStates = new Map(), viewing = new Set();
let analysis, analysisSequence = 0, classifications = new Map();
let workerCount = 0, prListSequence = 0;
window.MonacoEnvironment = { getWorker: (_, label) => {
    const worker = new Worker('/vendor/vs/base/worker/workerMain.js', { name: label }); workerCount++;
    worker.addEventListener('message', () => workerVerified = true);
    worker.addEventListener('error', event => workerError = event.message || 'Worker startup failed');
    return worker;
} };
function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
async function api(route, input, signal) {
    const response = await fetch(new URL(`api/${route}`, location.href), { method: input === undefined ? 'GET' : 'POST', headers: input === undefined ? {} : { 'Content-Type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input), signal });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`); return result;
}
function guard(action) { return async (...args) => { try { await action(...args); } catch (error) { if (error.name !== 'AbortError') notice(error.message, true); } }; }
function element(tag, text, className) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; }
function append(parent, ...nodes) { parent.append(...nodes); return parent; }
async function loadPrs() {
    const sequence = ++prListSequence;
    prs = []; renderPrs(); notice('Loading pull requests across repositories…');
    try {
        const result = await api(`prs?status=${encodeURIComponent($('status').value)}`);
        if (sequence !== prListSequence) return;
        prs = result.pullRequests; renderPrs();
        notice(`${prs.length} pull requests${result.errors?.length ? ` · ${result.errors.length} repositories unavailable` : ''}`);
        if (result.errors?.length) notice(result.errors.map(value => `${value.repository}: ${value.error}`).join('\n'), true);
    } catch (error) { if (sequence === prListSequence) throw error; }
}
function renderPrs() {
    const filter = $('pr-filter').value.toLowerCase(); const root = $('pr-list'); root.replaceChildren();
    for (const pr of prs.filter(pr => `${pr.id} ${pr.title} ${pr.repository} ${pr.createdBy}`.toLowerCase().includes(filter))) {
        const button = element('button', null, `pr-card${review?.pr.id === pr.id ? ' active' : ''}`);
        if (pr.isDraft === true) button.append(element('span', 'Draft', 'pr-state draft-state'));
        append(button, element('strong', `#${pr.id} ${pr.title}`), element('small', `${pr.repository} · ${pr.createdBy}`));
        button.onclick = guard(() => openReview(pr)); root.append(button);
    }
    if (!root.children.length) root.append(element('p', 'No pull requests match.', 'empty'));
}
async function openReview(pr) {
    const sequence = ++reviewNavigation; ++navigation; ++analysisSequence; controller?.abort(); current = null; review = null; selection = null; analysis = null; classifications.clear();
    $('dependencies').disabled = true; $('dependencies').textContent = 'Dependency diagrams'; $('filter-status').textContent = ''; $('ignored-file-status').textContent = ''; $('dependency-file-summary').hidden = true;
    diff?.setModel(null); models.forEach(model => { monaco.editor.setModelMarkers(model, 'roslyn', []); model.dispose(); }); models = [];
    for (const id of ['threads', 'drafts', 'file-tree']) $(id).replaceChildren();
    for (const id of ['preview-publish', 'publish', 'fetch', 'reload-review']) $(id).disabled = true;
    $('review-pr-state').hidden = true; $('pr-title').textContent = `Opening #${pr.id}…`; $('review-meta').textContent = ''; $('current-file').textContent = 'Select a file'; $('progress').textContent = '0 / 0';
    setEnabled(false); notice(`Opening #${pr.id}…`);
    const result = await api('review', { organization: pr.organization, project: pr.project, repositoryId: pr.repositoryId, id: pr.id });
    if (sequence !== reviewNavigation) return;
    review = result; renderReview(); renderPrs();
    if (review.localError) { notice(review.localError, true); diff?.setModel(null); models.forEach(model => { monaco.editor.setModelMarkers(model, 'roslyn', []); model.dispose(); }); models = []; return; }
    notice(`${review.files.length} changed files · iteration ${review.iteration.id}`);
    if (review.files.length) await openFile(review.files[0]);
    if (sequence === reviewNavigation) await loadAnalysis();
}
function renderReview() {
    $('pr-title').textContent = `#${review.pr.id} ${review.pr.title}`;
    $('review-pr-state').textContent = 'Draft'; $('review-pr-state').hidden = review.pr.isDraft !== true;
    $('review-meta').textContent = `${review.pr.repository} · ${review.pr.sourceRefName.replace('refs/heads/', '')} → ${review.pr.targetRefName.replace('refs/heads/', '')} · iteration ${review.iteration.id} · base ${review.base?.slice(0, 10) || 'unavailable'} · ${review.worktree?.path || 'no worktree'}`;
    $('fetch').disabled = !review.worktree; $('reload-review').disabled = false;
    renderFiles(); renderDiscussion();
}
function ignoreReasons(file) { return classifications.get(file.path)?.reasons || []; }
function visibleFiles() {
    const filter = $('file-filter').value.toLowerCase();
    return (review?.files || []).filter(file => [file.path, file.oldPath].some(path => path?.toLowerCase().includes(filter)) && (config?.reviewFilters?.showIgnored || !ignoreReasons(file).length));
}
async function loadAnalysis() {
    if (!review || review.localError) return;
    const captured = review, sequence = ++analysisSequence;
    $('filter-status').textContent = 'Analyzing immutable changes locally…';
    try {
        const filters = config.reviewFilters || {}, result = await api('analysis', { key: captured.key, classify: Boolean(filters.formatting || filters.usings || filters.renames !== false || filters.namespaceRenames || filters.generated !== false) });
        if (review !== captured || sequence !== analysisSequence) return;
        analysis = result; classifications = new Map(result.classifications.map(value => [value.path, value]));
        $('filter-status').textContent = 'Local analysis complete · no inference';
        $('dependencies').disabled = false;
        $('dependencies').textContent = `Dependency diagrams (${result.dependencies.changes}${result.dependencies.warnings.length ? ' · warnings' : ''})`;
        renderFiles(); renderDependencies();
        if (current && ignoreReasons(current).length && !config.reviewFilters?.showIgnored) {
            const next = visibleFiles()[0];
            if (next) await openFile(next);
            else { ++navigation; controller?.abort(); current = null; selection = null; diff?.setModel(null); models.forEach(model => { monaco.editor.setModelMarkers(model, 'roslyn', []); model.dispose(); }); models = []; $('current-file').textContent = 'All files ignored — show ignored files to review them';             setEnabled(false); renderFiles(); renderDiscussion(); }
        }
    } catch (error) { if (review === captured && sequence === analysisSequence) { $('filter-status').textContent = 'Analysis unavailable; files remain visible'; notice(error.message, true); } }
}
function renderDependencies() {
    if (!analysis) return;
    const graph = analysis.dependencies;
    $('dependency-stats').textContent = `${graph.changes} changed dependency declarations · ${graph.manifests} changed manifests · ${graph.sourceFiles || 0} C# files${graph.warnings.length ? ` · ${graph.warnings.length} warnings` : ''}`;
    renderDependencyDiagrams($('dependency-diagrams'), graph, $('dependency-context').checked, guard(async path => {
        const file = review.files.find(file => file.path === path || file.oldPath === path);
        if (file) { $('dependency-dialog').close(); await openFile(file); }
    }));
}
function renderDependencySummary() {
    const root = $('dependency-file-summary'); root.replaceChildren(); root.hidden = true;
    if (!analysis || !current) return;
    const edges = analysis.dependencies.edges.filter(edge => [current.path, current.oldPath].includes(edge.owner) && edge.status !== 'unchanged');
    const warnings = analysis.dependencies.warnings.filter(warning => [current.path, current.oldPath].includes(warning.path));
    if (!edges.length && !warnings.length) return;
    root.hidden = false;
    const button = element('button', `${edges.length} dependency changes${warnings.length ? ' · analysis warning' : ''} — view diagrams`);
    button.onclick = () => { renderDependencies(); $('dependency-dialog').showModal(); }; root.append(button);
}
$('review-filters').onclick = () => {
    const filters = config.reviewFilters || {};
    for (const name of ['resources', 'formatting', 'usings', 'renames', 'projectReferenceRenames', 'namespaceRenames', 'generated', 'designers', 'migrations']) $(`ignore-${name}`).checked = ['renames', 'projectReferenceRenames', 'generated', 'designers', 'migrations'].includes(name) ? filters[name] !== false : Boolean(filters[name]);
    $('ignore-patterns').value = (filters.patterns || []).join('\n'); $('show-ignored').checked = Boolean(filters.showIgnored);
    const pairs = analysis?.renames?.pairs || [];
    $('detected-renames').textContent = pairs.length ? `Detected types: ${pairs.map(pair => `${pair.namespace ? `${pair.namespace}.` : ''}${pair.from} → ${pair.to}`).join('; ')}` : 'No unambiguous type renames detected in analyzed files.';
    $('filters-dialog').showModal();
};
$('cancel-filters').onclick = () => $('filters-dialog').close();
$('filters-form').onsubmit = guard(async event => {
    event.preventDefault();
    const filters = Object.fromEntries(['resources', 'formatting', 'usings', 'renames', 'projectReferenceRenames', 'namespaceRenames', 'generated', 'designers', 'migrations'].map(name => [name, $(`ignore-${name}`).checked]));
    filters.patterns = $('ignore-patterns').value.split('\n').map(value => value.trim()).filter(Boolean); filters.showIgnored = $('show-ignored').checked;
    config = await api('filters', { filters }); $('filters-dialog').close(); classifications.clear(); renderFiles(); await loadAnalysis();
    if (!current && visibleFiles().length) await openFile(visibleFiles()[0]);
});
$('dependencies').onclick = () => { renderDependencies(); $('dependency-dialog').showModal(); };
$('dependency-context').onchange = renderDependencies;
$('close-dependencies').onclick = () => $('dependency-dialog').close();
function renderFiles() {
    if (!review) return;
    const root = $('file-tree'), focused = document.activeElement?.dataset.reviewedPath, scroll = root.scrollTop;
    const expansion = new Map([...root.querySelectorAll('details[data-folder]')].map(node => [node.dataset.folder, node.open])); root.replaceChildren();
    const directories = new Map([['', root]]);
    const shown = visibleFiles(), ignored = review.files.filter(file => ignoreReasons(file).length).length;
    for (const file of shown) {
        const parts = file.path.split('/'); let path = '', parent = root;
        for (const directory of parts.slice(0, -1)) {
            path = path ? `${path}/${directory}` : directory;
            if (!directories.has(path)) {
                const folderPath = path, descendants = review.files.filter(file => file.path.startsWith(`${folderPath}/`) && !ignoreReasons(file).length);
                const reviewedCount = descendants.filter(file => file.viewed).length;
                const reviewed = element('input'); reviewed.type = 'checkbox'; reviewed.dataset.reviewedPath = `${folderPath}/`;
                reviewed.checked = descendants.length > 0 && reviewedCount === descendants.length; reviewed.indeterminate = reviewedCount > 0 && reviewedCount < descendants.length;
                reviewed.disabled = !descendants.length || descendants.some(file => !file.fingerprint || viewing.has(file.path));
                reviewed.setAttribute('aria-label', `Reviewed folder ${folderPath}`); reviewed.title = 'Mark all non-ignored files in this folder reviewed, including collapsed and search-hidden files';
                reviewed.onclick = event => event.stopPropagation(); reviewed.onchange = guard(() => markFilesViewed(descendants.map(file => file.path), reviewed.checked, true));
                const details = element('details'); details.dataset.folder = folderPath; details.open = expansion.get(folderPath) ?? true; const items = element('div'); items.style.paddingLeft = '10px';
                append(details, append(element('summary'), reviewed, element('span', directory)), items); parent.append(details); directories.set(path, items);
            }
            parent = directories.get(path);
        }
        const reasons = ignoreReasons(file);
        const button = element('button', null, `file${current?.path === file.path ? ' active' : ''}${reasons.length ? ' ignored-file' : ''}`); button.title = `${pathChange(file)?.paths || file.path}${reasons.length ? ` · ignored: ${reasons.join(', ')}` : ''}`;
        button.dataset.path = file.path;
        append(button, element('span', parts.at(-1), 'file-name'), element('span', pathChange(file)?.label || file.status[0], 'file-status'));
        button.onclick = guard(() => openFile(file));
        const reviewed = element('input'); reviewed.type = 'checkbox'; reviewed.checked = file.viewed === true; reviewed.dataset.reviewedPath = file.path;
        reviewed.disabled = viewing.has(file.path); reviewed.setAttribute('aria-label', `Reviewed ${file.path}`); reviewed.title = 'Mark this file reviewed (saved locally)';
        reviewed.onchange = guard(() => markFileViewed(file.path, reviewed.checked));
        parent.append(append(element('div', null, 'file-row'), reviewed, button));
    }
    const reviewable = review.files.filter(file => !ignoreReasons(file).length);
    $('progress').textContent = `${reviewable.filter(file => file.viewed).length} / ${reviewable.length}${ignored ? ` · ${ignored} ignored` : ''}`;
    $('review-filters').textContent = `Review filters${ignored ? ` (${ignored} ignored)` : ''}`;
    if (!shown.length) root.append(element('p', ignored ? 'No visible files match. Change filters or show ignored files.' : 'No changed files match.', 'empty'));
    $('ignored-file-status').textContent = current && ignoreReasons(current).length ? `Ignored: ${ignoreReasons(current).join(', ')}. Shown explicitly; not marked viewed.` : '';
    const candidates = review.files.filter(file => classifications.get(file.path)?.namespaceTextOnly && !file.error && !file.binary && !file.modeChanged).length;
    $('namespace-hint').hidden = config?.reviewFilters?.namespaceRenames === true || !candidates;
    $('namespace-hint-text').textContent = `${candidates} namespace-only candidates; text-only filtering is off (not compiler proof).`;
    if (!current || !viewing.has(current.path)) $('viewed').checked = current ? review.files.find(file => file.path === current.path)?.viewed === true : false;
    if (current) $('viewed').disabled = viewing.has(current.path);
    root.scrollTop = scroll;
    if (focused) [...root.querySelectorAll('[data-reviewed-path]')].find(node => node.dataset.reviewedPath === focused)?.focus({ preventScroll: true });
    renderDependencySummary();
}
function setEnabled(value) { for (const id of ['viewed', 'comment', 'copilot', 'previous-file', 'next-file', 'previous-diff', 'next-diff']) $(id).disabled = !value; $('roslyn').disabled = !value || current?.language !== 'csharp' || !config?.roslyn.available; }
const editorReady = new Promise((resolve, reject) => {
    if (typeof window.require !== 'function') { reject(new Error('Local Monaco AMD loader unavailable')); return; }
    window.require.config({ paths: { vs: '/vendor/vs' } });
    window.require(['vs/editor/editor.main'], () => {
        try {
            monacoLoaded = true;
            diff = monaco.editor.createDiffEditor($('diff'), { readOnly: true, originalEditable: false, renderSideBySide: true, useInlineViewWhenSpaceIsLimited: false, automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, renderIndicators: true, diffWordWrap: 'off', find: { seedSearchStringFromSelection: 'always', autoFindInSelection: 'never' } });
            watchAppTheme(monaco, diff);
            for (const [side, pane] of [['left', diff.getOriginalEditor()], ['right', diff.getModifiedEditor()]]) {
                pane.onDidFocusEditorWidget(() => activeSide = side);
                pane.onMouseDown(() => activeSide = side);
                pane.addAction({ id: `local-review-comment-${side}`, label: 'Add review comment on selected lines', contextMenuGroupId: 'navigation', contextMenuOrder: 1.5, keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyM], run: () => { activeSide = side; showComment(); } });
            }
            $('editor-status').textContent = 'Monaco ready · immutable commit blobs'; resolve(diff);
        } catch (error) { reject(error); }
    }, reject);
});
editorReady.catch(error => notice(`Monaco initialization failed: ${error.message}`, true));
async function openFile(file) {
    const sequence = ++navigation; selection = null; controller?.abort(); controller = new AbortController();
    const key = review.key; setEnabled(false); $('current-file').textContent = `${pathChange(file)?.paths || file.path} · loading…`;
    const result = await api(`file?key=${encodeURIComponent(key)}&path=${encodeURIComponent(file.path)}`, undefined, controller.signal);
    await editorReady; if (sequence !== navigation || key !== review?.key) return;
    if (current) { modelStates.set(`${key}:${current.path}`, diff.saveViewState()); if (modelStates.size > 100) modelStates.delete(modelStates.keys().next().value); }
    diff.setModel(null); models.forEach(model => { monaco.editor.setModelMarkers(model, 'roslyn', []); model.dispose(); }); models = [];
    current = { ...file, ...result };
    if (result.binary) { $('current-file').textContent = `${pathChange(file)?.paths || file.path} · ${result.reason || 'binary (not rendered)'}`; setEnabled(false); $('previous-file').disabled = false; $('next-file').disabled = false; $('viewed').disabled = false; $('viewed').checked = file.viewed; renderFiles(); renderDiscussion(); return; }
    models = [monaco.editor.createModel(result.original, result.language, monaco.Uri.parse(`review://base/${encodeURIComponent(key)}/${encodeURIComponent(file.oldPath)}`)), monaco.editor.createModel(result.modified, result.language, monaco.Uri.parse(`review://source/${encodeURIComponent(key)}/${encodeURIComponent(file.path)}`))];
    diff.setModel({ original: models[0], modified: models[1] });
    const saved = modelStates.get(`${key}:${file.path}`); if (saved) diff.restoreViewState(saved);
    $('current-file').textContent = pathChange(file)?.paths || file.path; $('viewed').checked = file.viewed; setEnabled(true); renderFiles(); renderDiscussion();
    diff.getModifiedEditor().deltaDecorations([], result.threads.filter(thread => !thread.isDeleted && thread.threadContext?.rightFileStart && threadCoordinatesCurrent(thread)).map(thread => ({ range: new monaco.Range(thread.threadContext.rightFileStart.line, 1, thread.threadContext.rightFileEnd?.line || thread.threadContext.rightFileStart.line, 1), options: { isWholeLine: true, linesDecorationsClassName: 'review-comment-line', hoverMessage: { value: `Review thread #${thread.id}` } } })));
}
function threadCoordinatesCurrent(thread) {
    const context = thread.pullRequestThreadContext;
    const iteration = context?.iterationContext;
    const tracking = context?.trackingCriteria;
    return (iteration?.firstComparingIteration === review?.iteration.id && iteration?.secondComparingIteration === review?.iteration.id)
        || (tracking?.firstComparingIteration === review?.iteration.id && tracking?.secondComparingIteration === review?.iteration.id);
}
function renderDiscussion() {
    $('threads').replaceChildren(); $('drafts').replaceChildren(); if (!review) return;
    const threads = current ? current.threads : review.threads;
    for (const thread of threads.filter(thread => !thread.isDeleted)) {
        const node = element('div', null, 'thread'), context = thread.threadContext;
        const position = context?.rightFileStart || context?.leftFileStart;
        const location = element('button', `#${thread.id} · ${thread.status || 'active'}${position ? ` · L${position.line}` : ' · PR discussion'}`, 'thread-location');
        location.disabled = !current || !threadCoordinatesCurrent(thread);
        location.onclick = () => { if (position && diff && threadCoordinatesCurrent(thread)) { const editor = context.rightFileStart ? diff.getModifiedEditor() : diff.getOriginalEditor(); editor.revealLineInCenter(position.line); editor.setPosition({ lineNumber: position.line, column: 1 }); } };
        node.append(location);
        const iteration = thread.pullRequestThreadContext?.iterationContext?.secondComparingIteration;
        if (position && !threadCoordinatesCurrent(thread)) node.append(element('small', `Original iteration ${iteration || 'unknown'}; historical coordinates are not placed on current code.`));
        for (const comment of (thread.comments || []).filter(comment => !comment.isDeleted)) append(node, element('strong', comment.author?.displayName || 'Azure DevOps'), element('p', comment.content));
        $('threads').append(node);
    }
    if (!$('threads').children.length) $('threads').append(element('p', 'No threads for this file.', 'empty'));
    for (const draft of review.drafts || []) {
        const node = element('div', null, 'draft'); append(node, element('strong', `Local draft · ${draft.side} L${draft.startLine}-${draft.endLine}`), element('small', `${draft.path} · iteration ${draft.iteration}`), element('p', draft.content));
        if (draft.status === 'publishing') node.append(element('p', 'Uncertain publish outcome. Check Azure DevOps before retrying.'));
        else { const remove = element('button', 'Remove draft'); remove.onclick = guard(async () => { review.drafts = (await api('draft/remove', { key: review.key, id: draft.id })).drafts; renderDiscussion(); }); node.append(remove); }
        $('drafts').append(node);
    }
    const previewDisabled = !review.drafts?.length || Boolean(review.localError) || review.drafts.some(draft => draft.status === 'publishing');
    $('preview-publish').disabled = previewDisabled;
    $('publish').disabled = !config?.writeEnabled || previewDisabled;
    $('publish').textContent = `Publish ${review.drafts?.length || 0} drafts`;
}
function selectedRange() {
    if (!current || current.binary || !diff) throw new Error('Select a text file first');
    const left = activeSide === 'left'; const editor = left ? diff.getOriginalEditor() : diff.getModifiedEditor();
    const range = editor.getSelection();
    let endLine = range.endLineNumber;
    const startOffset = range.isEmpty() ? 0 : range.startColumn - 1;
    if (!range.isEmpty() && range.endColumn === 1 && endLine > range.startLineNumber) endLine--;
    const endOffset = range.isEmpty() || endLine !== range.endLineNumber ? Math.max(0, editor.getModel().getLineLength(endLine) - 1) : Math.max(0, range.endColumn - 2);
    return { key: review.key, path: current.path, side: left ? 'left' : 'right', startLine: range.startLineNumber, endLine, startOffset, endOffset };
}
function showComment() { try { selection = selectedRange(); $('comment-location').textContent = `${selection.path} · ${selection.side} L${selection.startLine}-${selection.endLine}`; $('comment-content').value = ''; $('composer').showModal(); $('comment-content').focus(); } catch (error) { notice(error.message, true); } }
function navigateFile(direction) { if (!review || !current) return; const files = visibleFiles(); const index = files.findIndex(file => file.path === current.path); const file = files[index + direction]; if (file) return openFile(file); }
async function markFilesViewed(paths, viewed, batch = false) {
    const captured = review;
    if (!captured || !paths.length || paths.some(path => viewing.has(path))) return;
    paths.forEach(path => viewing.add(path)); renderFiles();
    try {
        const result = await api(batch ? 'viewed/batch' : 'viewed', batch ? { key: captured.key, paths, viewed, source: captured.source, base: captured.base } : { key: captured.key, path: paths[0], viewed });
        if (review !== captured) return;
        for (const path of paths) captured.files.find(file => file.path === path).viewed = result.viewed;
        if (paths.includes(current?.path)) current.viewed = result.viewed;
    } finally { paths.forEach(path => viewing.delete(path)); if (review === captured) renderFiles(); }
}
async function markFileViewed(path, viewed) { await markFilesViewed([path], viewed); }
async function markViewed() { if (current) await markFileViewed(current.path, $('viewed').checked); }
$('namespace-hint-action').onclick = () => $('review-filters').click();
$('settings-button').onclick = () => { $('organization').value = config?.organization || ''; $('roots').value = (config?.roots || []).join('\n'); $('write-enabled').checked = config?.writeEnabled; $('write-enabled').disabled = false; $('settings').showModal(); };
$('close-settings').onclick = () => $('settings').close();
$('config-form').onsubmit = guard(async event => { event.preventDefault(); config = await api('config', { organization: $('organization').value.trim(), roots: $('roots').value.split('\n').map(path => path.trim()).filter(Boolean), writeEnabled: $('write-enabled').checked }); $('connection').textContent = config.organization; $('settings').close(); if (review) renderDiscussion(); await loadPrs(); });
$('refresh').onclick = guard(loadPrs); $('status').onchange = guard(loadPrs); $('pr-filter').oninput = renderPrs; $('file-filter').oninput = renderFiles;
$('reload-review').onclick = guard(() => openReview(review.pr));
$('fetch').onclick = guard(async () => { if (!confirm('Fetch PR source and target refs from the matching remote? This downloads Git objects but does not checkout or modify files.')) return; const captured = review; notice('Fetching refs…'); await api('fetch', { key: captured.key }); if (review !== captured) return; await openReview(captured.pr); notice('Refs fetched; local diff ready.'); });
$('previous-file').onclick = guard(() => navigateFile(-1)); $('next-file').onclick = guard(() => navigateFile(1));
$('previous-diff').onclick = () => diff?.goToDiff('previous'); $('next-diff').onclick = () => diff?.goToDiff('next'); $('viewed').onchange = guard(markViewed);
$('comment').onmousedown = () => { try { selection = selectedRange(); } catch {} }; $('comment').onclick = () => { if (!selection || selection.path !== current?.path) showComment(); else { $('comment-location').textContent = `${selection.path} · ${selection.side} L${selection.startLine}-${selection.endLine}`; $('comment-content').value = ''; $('composer').showModal(); $('comment-content').focus(); } };
$('cancel-comment').onclick = () => $('composer').close();
$('comment-form').onsubmit = guard(async event => { event.preventDefault(); review.drafts = (await api('draft', { ...selection, content: $('comment-content').value })).drafts; $('composer').close(); renderDiscussion(); notice('Draft saved locally. Nothing published.'); });
$('close-publish-preview').onclick = () => $('publish-preview').close();
$('preview-publish').onclick = guard(async () => { const key = review.key, plan = await api('publish/preview', { key }); if (review?.key !== key) return; $('publish-plan').textContent = JSON.stringify(plan, null, 2); $('publish-preview').showModal(); });
$('publish').onclick = guard(async () => { const pr = review.pr, key = review.key; $('publish').disabled = true; try {
    const plan = await api('publish/preview', { key });
    if (review?.key !== key) return;
    const locations = plan.payloads.map(({ draft }) => `${draft.path} · ${draft.side} L${draft.startLine}-${draft.endLine}: ${draft.content}`).join('\n\n');
    if (!confirm(`Publish ${plan.payloads.length} comments to Azure DevOps PR #${plan.prId}, iteration ${plan.iteration}? Live posting has not been tested.\n\n${locations}`)) return;
    const result = await api('publish', { key, planToken: plan.planToken }); notice(`Published ${result.published.length} inline comments.`); if (review?.key === key) await openReview(pr);
} catch (error) { if (review?.key === key) await openReview(pr).catch(() => {}); throw error; } finally { renderDiscussion(); } });
$('copilot').onclick = guard(() => { selection = selectedRange(); $('copilot-scope').value = 'range'; $('copilot-dialog').showModal(); });
$('cancel-copilot').onclick = () => $('copilot-dialog').close();
$('copilot-form').onsubmit = guard(async event => { event.preventDefault(); const scope = $('copilot-scope').value;
    const input = scope === 'file' ? { ...selection, startLine: undefined, endLine: undefined } : selection;
    await api('copilot', { ...input, instruction: $('copilot-instruction').value }); $('copilot-dialog').close(); notice('Selection sent to Copilot for read-only analysis.'); });
$('roslyn').onclick = guard(async () => {
    const captured = review, file = current, model = models[1], sequence = navigation;
    if (!captured || !file || !model) return;
    notice('Running local Roslyn diagnostics and dead-code analysis…');
    await api('roslyn/start', { key: captured.key });
    const result = await api(`roslyn/diagnostics?key=${encodeURIComponent(captured.key)}&path=${encodeURIComponent(file.path)}`);
    if (sequence !== navigation || review !== captured || current !== file || models[1] !== model || model.isDisposed()) return;
    monaco.editor.setModelMarkers(model, 'roslyn', diagnosticMarkers(monaco, result.diagnostics));
    notice(`Roslyn: ${result.diagnostics.length} diagnostics · ${result.deadCode?.length || 0} dead-code / unused-code findings. Single-file analysis only; solution-wide references are not loaded. Findings do not automatically hide files or prove public APIs unused.`);
});
$('diagnostics').onclick = guard(async () => { const result = await api('diagnostics'); notice(`Monaco loaded: ${monacoLoaded}; diff ready: ${Boolean(diff)}; worker: ${workerVerified ? 'verified' : workerError || 'not yet verified'}; Roslyn installed: ${result.roslyn.available}; initialized: ${result.roslyn.initialized}. Publishing contract verified; live POST not tested. Publishing requires Settings opt-in and a confirmed current-iteration preview; no comments are posted automatically.`); });
document.addEventListener('keydown', guard(async event => {
    if (document.querySelector('dialog[open]')) return;
    const typing = event.target.closest('input,textarea,[contenteditable=true]') || diff?.getOriginalEditor().hasTextFocus() || diff?.getModifiedEditor().hasTextFocus();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') { event.preventDefault(); $('file-filter').focus(); $('file-filter').select(); }
    else if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); await navigateFile(event.key === 'ArrowUp' ? -1 : 1); }
    else if (event.key === 'F8') { event.preventDefault(); diff?.goToDiff(event.shiftKey ? 'previous' : 'next'); }
    else if (!typing && !document.querySelector('dialog[open]') && event.key.toLowerCase() === 'v' && current) { event.preventDefault(); $('viewed').checked = !$('viewed').checked; await markViewed(); }
}));
window.reviewCanvasDiagnostics = async () => {
    await editorReady;
    for (let attempt = 0; models.length && (!workerVerified || diff.getLineChanges() === null) && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    return { monacoLoaded, workerVerified, workerError, workerCount, diffEditorReady: Boolean(diff), currentPath: current?.path, modelCount: monaco.editor.getModels().length, changedLines: diff.getLineChanges()?.length || 0 };
};
config = await api('config'); $('connection').textContent = config.organization || 'Configure organization';
if (config.organization) await guard(loadPrs)(); else $('settings-button').click();
