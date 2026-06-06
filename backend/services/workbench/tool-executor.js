async function executeToolBatch(toolUses, executeOne, options = {}) {
    const uses = Array.isArray(toolUses) ? toolUses : [];
    const {
        canRunInParallel = () => false,
        parallel = false,
        onResult = () => {}
    } = options;

    if (uses.length === 0) return [];

    const allParallelSafe = parallel && uses.length > 1 && uses.every(toolUse => canRunInParallel(toolUse));

    if (!allParallelSafe) {
        const results = [];
        for (const toolUse of uses) {
            const result = await executeOne(toolUse);
            results.push(result);
            onResult(result, toolUse);
        }
        return results;
    }

    const settled = await Promise.allSettled(uses.map(toolUse => executeOne(toolUse)));
    return settled.map((item, index) => {
        const toolUse = uses[index];
        const result = item.status === 'fulfilled'
            ? item.value
            : {
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: `[Tool Batch Error] ${item.reason?.message || item.reason || 'unknown error'}`,
                is_error: true
            };
        onResult(result, toolUse);
        return result;
    });
}

module.exports = {
    executeToolBatch
};
