function clamp01(value, fallback = 0.75) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeProvenance(metadata = {}, options = {}) {
  const now = new Date().toISOString();
  const ttl = metadata.ttl || options.ttl || null;
  const ttlDate = ttl === 0 ? new Date(0).toISOString() : ttl;

  return {
    source: String(options.source || metadata.source || 'unknown'),
    sourceSessionId: String(options.sourceSessionId || metadata.sourceSessionId || ''),
    sourceMessageId: String(options.sourceMessageId || metadata.sourceMessageId || ''),
    sourceType: String(options.sourceType || metadata.sourceType || ''),
    confidence: clamp01(options.confidence ?? metadata.confidence, 0.75),
    pinned: Boolean(options.pinned ?? metadata.pinned ?? false),
    createdAt: String(options.createdAt || metadata.createdAt || now),
    updatedAt: String(options.updatedAt || metadata.updatedAt || now),
    lastUsedAt: String(options.lastUsedAt || metadata.lastUsedAt || ''),
    ttl: ttlDate || null,
  };
}

function memoryText(item = {}) {
  return [
    item.title,
    item.summary,
    item.value,
    item.content,
    item.category,
    item.key,
    item.topic,
  ].filter(Boolean).join(' ');
}

function scoreMemoryQuality(item = {}) {
  const text = memoryText(item);
  const reasons = [];
  let score = 50;

  if (/prefer|must|should|always|never|workflow|rule|guideline/i.test(text)) {
    score += 12;
    reasons.push('durable workflow signal');
  }
  if (/current|active|blocked|fix|debug|today|recent|in_progress/i.test(text)) {
    score += 8;
    reasons.push('current-work signal');
  }
  if (/resolved|old|previous|past|earlier|temporary|transient/i.test(text)) {
    score -= 15;
    reasons.push('stale or transient signal');
  }
  if (text.length < 20) {
    score -= 18;
    reasons.push('too short');
  }
  if (text.length > 900) {
    score -= 8;
    reasons.push('long item may need compaction');
  }
  if (item.pinned) {
    score += 15;
    reasons.push('pinned');
  }

  const confidence = clamp01(item.confidence, 0.75);
  score += (confidence - 0.75) * 20;

  if (item.updatedAt || item.lastUsedAt) {
    const seen = new Date(item.lastUsedAt || item.updatedAt || 0).getTime();
    if (Number.isFinite(seen) && seen > 0) {
      const ageDays = (Date.now() - seen) / 86400000;
      if (ageDays > 180) score -= 12;
      if (ageDays > 365) score -= 18;
    }
  }

  if (item.ttl && new Date(item.ttl).getTime() < Date.now()) {
    score -= 30;
    reasons.push('expired');
  }

  const clampedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: clampedScore,
    confidence,
    reasons,
    label: clampedScore >= 80 ? 'high' : clampedScore >= 55 ? 'normal' : clampedScore >= 35 ? 'low' : 'review',
  };
}

function decorateMemoryQuality(item = {}) {
  return {
    ...item,
    quality: scoreMemoryQuality(item),
    provenance: normalizeProvenance(item.metadata || {}, item),
  };
}

module.exports = {
  clamp01,
  decorateMemoryQuality,
  memoryText,
  normalizeProvenance,
  scoreMemoryQuality,
};
