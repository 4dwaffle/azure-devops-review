const svgNS = 'http://www.w3.org/2000/svg'; let generation = 0;
function svgElement(tag, attributes = {}, text) {
    const node = document.createElementNS(svgNS, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text; return node;
}
const shortened = (value, length = 45) => value.length > length ? `${value.slice(0, length - 1)}…` : value;
function version(edge) {
    const before = edge.before?.version || '(unspecified)', after = edge.after?.version || '(unspecified)';
    return edge.status === 'modified' && before !== after ? `${before} → ${after}` : edge.status === 'removed' ? before : after;
}
function diagram(owner, edges, nodes) {
    const height = edges.length * 76 + 24, middle = height / 2;
    const svg = svgElement('svg', { viewBox: `0 0 780 ${height}`, role: 'img', 'aria-label': `Dependency changes declared by ${owner}` });
    const colors = { added: 'var(--true-color-blue, currentColor)', removed: 'var(--true-color-red, currentColor)', modified: 'var(--true-color-blue, currentColor)', unchanged: 'var(--text-color-muted, currentColor)' };
    const defs = svgElement('defs'); const id = ++generation;
    for (const [status, color] of Object.entries(colors)) {
        const marker = svgElement('marker', { id: `dependency-arrow-${id}-${status}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
        marker.append(svgElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: color })); defs.append(marker);
    }
    svg.append(defs);
    edges.forEach((edge, index) => {
        const y = index * 76 + 50, color = colors[edge.status];
        svg.append(svgElement('path', { d: `M 250 ${middle} C 325 ${middle}, 325 ${y}, 400 ${y}`, fill: 'none', stroke: color, 'stroke-width': edge.status === 'unchanged' ? 1 : 2, 'stroke-dasharray': edge.status === 'removed' ? '5 4' : 'none', 'marker-end': `url(#dependency-arrow-${id}-${edge.status})` }));
        const group = svgElement('g', { class: `dependency-node dependency-${edge.status}` });
        const label = nodes.get(edge.to)?.label || edge.name;
        group.append(svgElement('title', {}, `${edge.status.toUpperCase()}: ${label}\n${version(edge)}\n${edge.scope}${edge.condition ? `\nCondition: ${edge.condition}` : ''}\nBefore: ${JSON.stringify(edge.before)}\nAfter: ${JSON.stringify(edge.after)}`));
        group.append(svgElement('rect', { x: 402, y: y - 30, width: 365, height: 60, rx: 5, fill: 'var(--background-color-default, Canvas)', stroke: color }));
        group.append(svgElement('text', { x: 413, y: y - 10, fill: 'var(--text-color-default, CanvasText)', 'font-size': 13 }, shortened(label)));
        group.append(svgElement('text', { x: 413, y: y + 7, fill: 'var(--text-color-muted, CanvasText)', 'font-size': 11 }, shortened(`${edge.kind} · ${version(edge)}`)));
        group.append(svgElement('text', { x: 413, y: y + 22, fill: color, 'font-size': 11 }, shortened(`${edge.status} · ${edge.scope}${edge.condition ? ' · conditional' : ''}`)));
        svg.append(group);
    });
    const root = svgElement('g'); root.append(svgElement('title', {}, owner));
    root.append(svgElement('rect', { x: 10, y: middle - 27, width: 240, height: 54, rx: 5, fill: 'var(--background-color-default, Canvas)', stroke: 'var(--border-color-default, currentColor)' }));
    root.append(svgElement('text', { x: 21, y: middle - 2, fill: 'var(--text-color-default, CanvasText)', 'font-size': 13 }, shortened(owner.split('/').at(-1), 31)));
    root.append(svgElement('text', { x: 21, y: middle + 16, fill: 'var(--text-color-muted, CanvasText)', 'font-size': 11 }, 'declares / references'));
    svg.append(root); return svg;
}
export function renderDependencyDiagrams(container, graph, showUnchanged, openFile) {
    container.replaceChildren(); const nodes = new Map(graph.nodes.map(node => [node.id, node])), groups = new Map();
    const edges = graph.edges.filter(edge => showUnchanged || edge.status !== 'unchanged');
    edges.sort((a, b) => Number(a.status === 'unchanged') - Number(b.status === 'unchanged') || a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name));
    for (const edge of edges) { if (!groups.has(edge.owner)) groups.set(edge.owner, []); groups.get(edge.owner).push(edge); }
    if (!groups.size) { const message = document.createElement('p'); message.textContent = 'No declared dependency changes detected in the supported manifests.'; container.append(message); }
    let remaining = 200;
    for (const [owner, dependencies] of groups) {
        if (!remaining) break;
        const section = document.createElement('section'); section.className = 'dependency-card'; section.dataset.manifest = owner;
        const title = document.createElement('button'); title.className = 'dependency-owner'; title.textContent = owner; title.onclick = () => openFile(owner); section.append(title);
        const visible = dependencies.slice(0, Math.min(50, remaining)); remaining -= visible.length;
        const viewport = document.createElement('div'); viewport.className = 'dependency-viewport'; viewport.append(diagram(owner, visible, nodes)); section.append(viewport);
        if (visible.length < dependencies.length) { const note = document.createElement('p'); note.textContent = `Showing ${visible.length} of ${dependencies.length} declarations for this manifest. Open its immutable diff for the complete changes.`; section.append(note); }
        container.append(section);
    }
    if (edges.length > 200) { const note = document.createElement('p'); note.textContent = 'Diagrams are bounded to 200 declarations. The full changed-file diffs remain available.'; container.append(note); }
    for (const warning of graph.warnings) { const note = document.createElement('p'); note.className = 'analysis-warning'; note.textContent = `${warning.path}: ${warning.message}. Review this manifest manually.`; container.append(note); }
}
