import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../review-service.mjs';
test('Copilot receives the precise character range, while whole-file scope ignores selection offsets', async () => {
    const prompts = [], service = new ReviewService('.', {}, async prompt => prompts.push(prompt));
    const review = { key: 'org/repo/1', pr: { id: 1, repository: 'repo' }, source: 'source', worktree: { path: 'fixture' } };
    service.reviews.set(review.key, review); service.file = async () => ({ original: 'abcdef\nsecond', modified: 'abcdef\nsecond', binary: false });
    await service.copilot({ key: review.key, path: 'file.cs', side: 'right', startLine: 1, endLine: 1, startOffset: 2, endOffset: 4 });
    assert.match(prompts[0], /<selected-code>\ncde\n<\/selected-code>/); assert.doesNotMatch(prompts[0], /abcdef/);
    await service.copilot({ key: review.key, path: 'file.cs', side: 'right', startOffset: 2, endOffset: 4 });
    assert.match(prompts[1], /abcdef\nsecond/);
    await assert.rejects(service.copilot({ key: review.key, path: 'file.cs', side: 'right', startLine: 1, endLine: 1, startOffset: 4, endOffset: 2 }), /character selection/);
    assert.equal(prompts.length, 2);
});
