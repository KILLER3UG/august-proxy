const test = require('node:test');
const assert = require('node:assert/strict');

const modelList = require('../providers/model-list');

test('getModelList returns an array or a paginated object with models', async () => {
    const result = await modelList.getModelList();
    const models = Array.isArray(result) ? result : result.models;
    assert.ok(Array.isArray(models));
});

test('getModelList({ skeleton: true }) returns immediately with empty models and triggers background refresh', async () => {
    const t0 = Date.now();
    const result = await modelList.getModelList({ skeleton: true });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 500, 'skeleton must return fast');
    assert.deepEqual(result.models, []);
    assert.equal(result.hasMore, false);
});

test('getModelList({ limit, offset }) returns a paginated object', async () => {
    await modelList.getModelList({ refresh: true });
    const result = await modelList.getModelList({ limit: 2, offset: 0 });
    assert.ok(typeof result === 'object' && !Array.isArray(result));
    assert.ok(result.models.length <= 2);
    assert.equal(typeof result.total, 'number');
});

test('invalidateModelListCache forces a fresh fetch on next call', async () => {
    const a = await modelList.getModelList();
    modelList.invalidateModelListCache();
    const b = await modelList.getModelList({ refresh: true });
    const aArr = Array.isArray(a) ? a : a.models;
    const bArr = Array.isArray(b) ? b : b.models;
    assert.ok(aArr.length > 0);
    assert.ok(bArr.length > 0);
});

test('getModelListOpenAI returns OpenAI-shaped envelope with data array', async () => {
    const result = await modelList.getModelListOpenAI({ includeClientAliases: false, filterRoutable: false });
    assert.equal(result.object, 'list');
    assert.ok(Array.isArray(result.data));
    if (result.data.length > 0) {
        assert.equal(result.data[0].object, 'model');
        assert.ok(typeof result.data[0].id === 'string');
    }
});