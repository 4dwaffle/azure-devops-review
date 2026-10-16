import { XMLParser, XMLValidator } from 'fast-xml-parser';

// Read declarations only; never evaluate MSBuild or execute repository code.
export function isTestProject(contents) {
    if (typeof contents !== 'string' || contents.length > 200000 || /<!DOCTYPE/i.test(contents) || XMLValidator.validate(contents) !== true) return false;
    try {
        const project = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true, processEntities: false, removeNSPrefix: true }).parse(contents).Project;
        if (!project || typeof project !== 'object') return false;
        let marker = /(?:^|;)MSTest\.Sdk(?:\/[^;]+)?(?:;|$)/i.test(project['@_Sdk'] || ''), uncertain = false;
        const properties = [];
        function visit(object, conditional = false) {
            if (!object || typeof object !== 'object') return;
            if (Array.isArray(object)) { object.forEach(value => visit(value, conditional)); return; }
            conditional ||= Object.hasOwn(object, '@_Condition');
            for (const [name, values] of Object.entries(object)) {
                for (const value of Array.isArray(values) ? values : [values]) {
                    if (name === 'Import' || name === 'Choose') uncertain = true;
                    if (name === 'IsTestProject') {
                        const text = typeof value === 'object' ? value?.['#text'] : value;
                        if (conditional || typeof value === 'object' && Object.hasOwn(value, '@_Condition') || !/^(true|false)$/i.test(String(text).trim())) uncertain = true;
                        else properties.push(String(text).trim().toLowerCase());
                    }
                    const testPackage = name === 'PackageReference' && /^Microsoft\.NET\.Test\.Sdk$/i.test(value?.['@_Include'] || '');
                    const testSdk = name === 'Sdk' && /^MSTest\.Sdk$/i.test(value?.['@_Name'] || '');
                    if (testPackage || testSdk) {
                        if (conditional || Object.hasOwn(value, '@_Condition')) uncertain = true;
                        else marker = true;
                    }
                    if (!name.startsWith('@_')) visit(value, conditional || name === 'Target');
                }
            }
        }
        visit(project);
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
