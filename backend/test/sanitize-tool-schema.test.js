const { sanitizeToolSchema } = require('../services/tools/mcp-client');
const { sanitizeAnthropicToolDefinition, openAiToAnthropicToolDefinition } = require('../adapters/proxy-tools');
const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${e.message}`);
        failed++;
    }
}

console.log('sanitizeToolSchema tests:\n');

// 1. Raw array schema → fallback to empty object
test('raw array schema → {type:"object", properties:{}}', () => {
    const result = sanitizeToolSchema([
        { type: 'number' }, { type: 'number' }, { type: 'number' }
    ]);
    assert.deepStrictEqual(result, { type: 'object', properties: {} });
});

// 2. null/undefined → empty object
test('null → {type:"object", properties:{}}', () => {
    assert.deepStrictEqual(sanitizeToolSchema(null), { type: 'object', properties: {} });
});

test('undefined → {type:"object", properties:{}}', () => {
    assert.deepStrictEqual(sanitizeToolSchema(undefined), { type: 'object', properties: {} });
});

// 3. Valid schema pass-through (unchanged)
test('valid schema pass-through', () => {
    const input = {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'search query' },
            max_results: { type: 'integer' }
        },
        required: ['query']
    };
    const result = sanitizeToolSchema(input);
    assert.deepStrictEqual(result, input);
});

// 4. Missing type → auto-set to 'object'
test('missing type → type:"object"', () => {
    const result = sanitizeToolSchema({ properties: { q: { type: 'string' } } });
    assert.strictEqual(result.type, 'object');
    assert.deepStrictEqual(result.properties.q, { type: 'string' });
});

// 5. Missing properties on object type → empty properties
test('missing properties → properties:{}', () => {
    const result = sanitizeToolSchema({ type: 'object' });
    assert.deepStrictEqual(result.properties, {});
});

// 6. Array-of-type-object property → {type:'array', items:{oneOf:[...]}}
test('property with array of type objects → items:{oneOf:[...]}', () => {
    const input = {
        type: 'object',
        properties: {
            location: [
                { type: 'number' },
                { type: 'number' },
                { type: 'number' }
            ]
        }
    };
    const result = sanitizeToolSchema(input);
    assert.deepStrictEqual(result.properties.location, {
        type: 'array',
        items: { oneOf: [{ type: 'number' }, { type: 'number' }, { type: 'number' }] }
    });
});

// 7. Nested property sanitization
test('nested properties are sanitized', () => {
    const input = {
        type: 'object',
        properties: {
            config: {
                type: 'object',
                properties: {
                    bad: null
                }
            }
        }
    };
    const result = sanitizeToolSchema(input);
    assert.deepStrictEqual(result.properties.config.properties.bad, { type: 'string' });
});

// 8. Non-object property → {type:'string'}
test('non-object property value → {type:"string"}', () => {
    const input = {
        type: 'object',
        properties: {
            name: 'not a schema'
        }
    };
    const result = sanitizeToolSchema(input);
    assert.deepStrictEqual(result.properties.name, { type: 'string' });
});

// 9. Array property value (non-type-objects) → {type:'string'}
test('array property (non-type-objects) → {type:"string"}', () => {
    const input = {
        type: 'object',
        properties: {
            tags: [1, 2, 3]
        }
    };
    const result = sanitizeToolSchema(input);
    assert.deepStrictEqual(result.properties.tags, { type: 'string' });
});

// 10. String input → fallback
test('string input → {type:"object", properties:{}}', () => {
    assert.deepStrictEqual(sanitizeToolSchema('bad'), { type: 'object', properties: {} });
});

// 11. Nested anyOf with raw array of type objects (the real error case)
test('nested anyOf items with array of type objects → fixed', () => {
    const input = {
        type: 'object',
        properties: {
            value: {
                anyOf: [
                    {
                        type: 'array',
                        items: [
                            { maximum: 1, minimum: 0, type: 'number' },
                            { maximum: 1, minimum: 0, type: 'number' },
                            { maximum: 1, minimum: 0, type: 'number' },
                            { maximum: 1, minimum: 0, type: 'number' }
                        ]
                    },
                    { type: 'string' }
                ]
            }
        }
    };
    const result = sanitizeToolSchema(input);
    const valueSchema = result.properties.value;
    assert.strictEqual(valueSchema.anyOf[0].type, 'array');
    assert.deepStrictEqual(valueSchema.anyOf[0].items, {
        oneOf: [
            { maximum: 1, minimum: 0, type: 'number' },
            { maximum: 1, minimum: 0, type: 'number' },
            { maximum: 1, minimum: 0, type: 'number' },
            { maximum: 1, minimum: 0, type: 'number' }
        ]
    });
});

// 12. Deeply nested oneOf inside properties
test('deeply nested oneOf in properties → sanitized', () => {
    const input = {
        type: 'object',
        properties: {
            config: {
                type: 'object',
                properties: {
                    color: {
                        oneOf: [
                            [{ type: 'number' }, { type: 'number' }, { type: 'number' }],
                            { type: 'string' }
                        ]
                    }
                }
            }
        }
    };
    const result = sanitizeToolSchema(input);
    const colorSchema = result.properties.config.properties.color;
    // oneOf[0] is a raw array of type objects → should become {type:'array', items:{oneOf:[...]}}
    assert.deepStrictEqual(colorSchema.oneOf[0], {
        type: 'array',
        items: { oneOf: [{ type: 'number' }, { type: 'number' }, { type: 'number' }] }
    });
});

test('anthropic tool definition sanitizes OpenAI function parameters', () => {
    const result = sanitizeAnthropicToolDefinition({
        type: 'function',
        function: {
            name: 'bad_tool',
            description: 'has bad tuple items',
            parameters: {
                type: 'object',
                properties: {
                    value: {
                        anyOf: [{
                            type: 'array',
                            items: [
                                { maximum: 1, minimum: 0, type: 'number' },
                                { maximum: 1, minimum: 0, type: 'number' },
                                { maximum: 1, minimum: 0, type: 'number' },
                                { maximum: 1, minimum: 0, type: 'number' }
                            ]
                        }]
                    }
                }
            }
        }
    });
    assert.deepStrictEqual(result.input_schema.properties.value.anyOf[0].items, {
        oneOf: [
            { maximum: 1, minimum: 0, type: 'number' },
            { maximum: 1, minimum: 0, type: 'number' },
            { maximum: 1, minimum: 0, type: 'number' },
            { maximum: 1, minimum: 0, type: 'number' }
        ]
    });
});

test('openai-to-anthropic conversion sanitizes parameters', () => {
    const result = openAiToAnthropicToolDefinition({
        type: 'function',
        function: {
            name: 'bad_tool',
            description: 'has bad tuple items',
            parameters: {
                type: 'object',
                properties: {
                    value: {
                        anyOf: [{
                            type: 'array',
                            items: [
                                { maximum: 1, minimum: 0, type: 'number' },
                                { maximum: 1, minimum: 0, type: 'number' },
                                { maximum: 1, minimum: 0, type: 'number' },
                                { maximum: 1, minimum: 0, type: 'number' }
                            ]
                        }]
                    }
                }
            }
        }
    });
    assert.deepStrictEqual(result.input_schema.properties.value.anyOf[0].items, {
        oneOf: [
            { maximum: 1, minimum: 0, type: 'number' },
            { maximum: 1, minimum: 0, type: 'number' },
            { maximum: 1, minimum: 0, type: 'number' },
            { maximum: 1, minimum: 0, type: 'number' }
        ]
    });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
