const sqliteStore = require('./sqlite-memory-store');
const { buildModelMemoryPack: buildPack } = require('./memory-service');

function recordModelObservation(input = {}) {
    const modelId = String(input.modelId || input.model_id || input.model || '').trim();
    const summary = String(input.summary || input.observation || '').trim();
    if (!summary) throw new Error('summary is required');
    return sqliteStore.recordModelObservation({
        modelId,
        provider: input.provider || '',
        observationType: input.observationType || input.observation_type || 'note',
        summary,
        details: input.details || input.details_json || {},
        relatedMemory: input.relatedMemory || input.related_memory || {},
        source: input.source || 'model'
    });
}

function listModelObservations(options = {}) {
    return sqliteStore.listModelObservations(options);
}

function buildModelMemoryPack(options = {}) {
    return buildPack(options);
}

module.exports = {
    buildModelMemoryPack,
    listModelObservations,
    recordModelObservation
};
