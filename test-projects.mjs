import { XMLParser, XMLValidator } from 'fast-xml-parser';

// Read declarations only; never evaluate MSBuild or execute repository code.
export function isTestProject(contents) {
    if (typeof contents !== 'string' || contents.length > 200000 || /<!DOCTYPE/i.test(contents) || XMLValidator.validate(contents) !== true) return false;
    try {
        const project = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true, processEntities: false, removeNSPrefix: true }).parse(contents).Project;
        if (!project || typeof project !== 'object') return false;
        const attribute = (node, name) => Object.entries(node || {}).find(([key]) => key.toLowerCase() === '@_' + name.toLowerCase())?.[1];
        const hasAttribute = (node, name) => Object.keys(node || {}).some(key => key.toLowerCase() === '@_' + name.toLowerCase());
        const children = node => Object.entries(node || {}).filter(([name]) => !name.startsWith('@_')).flatMap(([name, values]) => (Array.isArray(values) ? values : [values]).map(value => [name, value]));
        let marker = /(?:^|;)MSTest\.Sdk(?:\/[^;]+)?(?:;|$)/i.test(attribute(project, 'Sdk') || ''), uncertain = hasAttribute(project, 'Condition');
        const properties = [];
        // Inspect only actual declaration locations. Item metadata and opaque
        // ProjectExtensions XML cannot declare a project property or SDK.
        for (const [group, object] of children(project)) {
            if (['Import', 'ImportGroup', 'Choose', 'Target'].includes(group)) uncertain = true;
            if (group === 'PropertyGroup') {
                for (const [name, value] of children(object)) {
                    if (name.toLowerCase() === 'istestproject') {
                        const text = typeof value === 'object' ? value?.['#text'] : value;
                        if (hasAttribute(object, 'Condition') || hasAttribute(value, 'Condition') || !/^(true|false)$/i.test(String(text).trim())) uncertain = true;
                        else properties.push(String(text).trim().toLowerCase());
                    }
                }
            }
            if (group === 'ItemGroup') {
                for (const [name, value] of children(object)) {
                    if (name !== 'PackageReference') continue;
                    // Wildcards, conditions and evaluation order can affect removal
                    // or exclusion; do not confirm membership from stale evidence.
                    if (hasAttribute(value, 'Remove') || hasAttribute(value, 'Exclude')) uncertain = true;
                    if (/^Microsoft\.NET\.Test\.Sdk$/i.test(attribute(value, 'Include') || '')) {
                        if (hasAttribute(object, 'Condition') || hasAttribute(value, 'Condition')) uncertain = true;
                        else marker = true;
                    }
                }
            }
            if (group === 'Sdk' && /^MSTest\.Sdk$/i.test(attribute(object, 'Name') || '')) {
                if (hasAttribute(object, 'Condition')) uncertain = true;
                else marker = true;
            }
        }
        if (uncertain || properties.includes('false')) return false;
        return properties.includes('true') || marker;
    } catch { return false; }
}

export function testProjectClassifier(projects = {}) {
    function snapshot(entries) {
        const directories = new Map();
        for (const entry of entries || []) {
            const directory = entry.path.slice(0, entry.path.lastIndexOf('/') + 1);
            const test = !entry.error && isTestProject(entry.contents);
            directories.set(directory, (directories.get(directory) ?? true) && test);
        }
        return path => {
            let directory = path.slice(0, path.lastIndexOf('/') + 1);
            while (true) {
                if (directories.has(directory)) return directories.get(directory);
                if (!directory) return false;
                directory = directory.slice(0, -1);
                directory = directory.slice(0, directory.lastIndexOf('/') + 1);
            }
        };
    }
    const before = snapshot(projects.base), after = snapshot(projects.source);
    return file => projects.complete === true && !file.error && !file.modeChanged &&
        (file.status === 'A' || before(file.oldPath || file.path)) &&
        (file.status === 'D' || after(file.path));
}
