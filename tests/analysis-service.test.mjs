import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewService } from '../review-service.mjs';

test('filter preferences survive a fresh service and cached analysis updates reasons without rereading blobs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-analysis-'));
    try {
        const defaults = { organization: 'org', roots: [], writeEnabled: false };
        const service = new ReviewService(root, defaults, () => { throw new Error('No inference allowed'); });
        const files = [
            { path: 'New.cs', oldPath: 'Old.cs', original: 'class Old {}', modified: 'class New {}' },
            { path: 'Ref.cs', oldPath: 'Ref.cs', original: 'Old x;', modified: 'New x;' },
            { path: 'package.json', oldPath: 'package.json', original: '{}', modified: '{"dependencies":{"A":"1"}}' },
        ];
        const review = { key: 'org/repo/1', files, worktree: { path: root }, drafts: [], threads: [] };
        let reads = 0;
        service.git = { file: async (_, path) => { reads++; return files.find(file => file.path === path); } };
        service.reviews.set(review.key, review);
        assert.equal((await service.config()).reviewFilters.generated, true);
        assert.equal((await service.config()).reviewFilters.designers, true); assert.equal((await service.config()).reviewFilters.migrations, true);
        assert.equal((await service.analysis({ key: review.key })).dependencies.changes, 1); assert.equal(reads, 1);
        assert.deepEqual((await service.analysis({ key: review.key, classify: true })).classifications.find(file => file.path === 'Ref.cs').reasons, ['detected type-rename references only']); assert.equal(reads, 4);
        await service.filters({ filters: { renames: false, generated: false, designers: false, migrations: false, resources: true, patterns: ['**/*.Designer.cs'], showIgnored: true } });
        assert.deepEqual((await service.analysis({ key: review.key, classify: true })).classifications.find(file => file.path === 'Ref.cs').reasons, []); assert.equal(reads, 4);
        const fresh = new ReviewService(root, defaults, () => {}), config = await fresh.config();
        assert.equal(config.reviewFilters.designers, false); assert.equal(config.reviewFilters.migrations, false); assert.equal(config.reviewFilters.generated, false); assert.equal(config.reviewFilters.renames, false); assert.equal(config.reviewFilters.resources, true); assert.equal(config.reviewFilters.showIgnored, true); assert.equal(config.organization, 'org'); assert.equal(config.writeEnabled, false);
        assert.equal('analysis' in service.publicReview(review), false); assert.equal('analysisWork' in service.publicReview(review), false);
        await assert.rejects(service.filters({ filters: { patterns: ['bad\npattern'] } }));
        assert.deepEqual((await fresh.config()).reviewFilters.patterns, ['**/*.Designer.cs']);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('analysis cannot apply classifications from a review replaced during its immutable read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-analysis-stale-'));
    try {
        const service = new ReviewService(root, { organization: 'org', roots: [] }, () => {});
        const review = { key: 'org/repo/1', files: [{ path: 'A.cs', oldPath: 'A.cs' }], worktree: { path: root } };
        let entered, finish;
        const started = new Promise(resolve => entered = resolve), blocked = new Promise(resolve => finish = resolve);
        service.git = { file: async () => { entered(); await blocked; return { original: 'class Old {}', modified: 'class New {}' }; } };
        service.reviews.set(review.key, review);
        const pending = service.analysis({ key: review.key, classify: true });
        const rejected = assert.rejects(pending, /PR changed while analyzing/);
        await started; service.reviews.set(review.key, { ...review }); finish(); await rejected;
    } finally { await rm(root, { recursive: true, force: true }); }
});
