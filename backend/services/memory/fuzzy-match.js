const UNICODE_MAP = {
    "\u201c": '"', "\u201d": '"',  // smart double quotes
    "\u2018": "'", "\u2019": "'",  // smart single quotes
    "\u2014": "--", "\u2013": "-", // em/en dashes
    "\u2026": "...", "\u00a0": " ", // ellipsis and non-breaking space
};

function getSequenceMatcherRatio(a, b) {
    if (a === b) return 1.0;
    if (!a || !b) return 0.0;
    
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    
    for (let i = 1; i <= m; i++) {
        const charA = a[i - 1];
        for (let j = 1; j <= n; j++) {
            if (charA === b[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }
    
    const lcs = dp[m][n];
    return (2.0 * lcs) / (m + n);
}

function unicodeNormalize(text) {
    let result = text;
    for (const [char, repl] of Object.entries(UNICODE_MAP)) {
        result = result.split(char).join(repl);
    }
    return result;
}

function buildOrigToNormMap(original) {
    const result = [];
    let normPos = 0;
    for (let i = 0; i < original.length; i++) {
        result.push(normPos);
        const char = original[i];
        const repl = UNICODE_MAP[char];
        normPos += repl !== undefined ? repl.length : 1;
    }
    result.push(normPos);
    return result;
}

function mapPositionsNormToOrig(origToNorm, normMatches) {
    const normToOrigStart = {};
    for (let origPos = 0; origPos < origToNorm.length - 1; origPos++) {
        const normPos = origToNorm[origPos];
        if (normToOrigStart[normPos] === undefined) {
            normToOrigStart[normPos] = origPos;
        }
    }
    
    const results = [];
    const origLen = origToNorm.length - 1;
    
    for (const [normStart, normEnd] of normMatches) {
        if (normToOrigStart[normStart] === undefined) continue;
        const origStart = normToOrigStart[normStart];
        
        let origEnd = origStart;
        while (origEnd < origLen && origToNorm[origEnd] < normEnd) {
            origEnd++;
        }
        results.push([origStart, origEnd]);
    }
    return results;
}

function calculateLinePositions(contentLines, startLine, endLine, contentLength) {
    let startPos = 0;
    for (let i = 0; i < startLine; i++) {
        startPos += contentLines[i].length + 1;
    }
    let endPos = 0;
    for (let i = 0; i < endLine; i++) {
        endPos += contentLines[i].length + 1;
    }
    endPos -= 1;
    endPos = Math.min(contentLength, endPos);
    return [startPos, endPos];
}

function findNormalizedMatches(content, contentLines, contentNormalizedLines, pattern, patternNormalized) {
    const patternNormLines = patternNormalized.split('\n');
    const numPatternLines = patternNormLines.length;
    const matches = [];
    
    for (let i = 0; i <= contentNormalizedLines.length - numPatternLines; i++) {
        const block = contentNormalizedLines.slice(i, i + numPatternLines).join('\n');
        if (block === patternNormalized) {
            const [startPos, endPos] = calculateLinePositions(contentLines, i, i + numPatternLines, content.length);
            matches.push([startPos, endPos]);
        }
    }
    return matches;
}

function strategyExact(content, pattern) {
    const matches = [];
    let start = 0;
    while (true) {
        const pos = content.indexOf(pattern, start);
        if (pos === -1) break;
        matches.push([pos, pos + pattern.length]);
        start = pos + 1;
    }
    return matches;
}

function strategyLineTrimmed(content, pattern) {
    const patternLines = pattern.split('\n').map(l => l.trim());
    const patternNormalized = patternLines.join('\n');
    
    const contentLines = content.split('\n');
    const contentNormalizedLines = contentLines.map(l => l.trim());
    
    return findNormalizedMatches(content, contentLines, contentNormalizedLines, pattern, patternNormalized);
}

function strategyWhitespaceNormalized(content, pattern) {
    const normalize = (s) => s.replace(/[ \t]+/g, ' ');
    const patternNormalized = normalize(pattern);
    const contentNormalized = normalize(content);
    
    const matchesInNormalized = strategyExact(contentNormalized, patternNormalized);
    if (matchesInNormalized.length === 0) return [];
    
    return mapNormalizedPositions(content, contentNormalized, matchesInNormalized);
}

function mapNormalizedPositions(original, normalized, normalizedMatches) {
    if (normalizedMatches.length === 0) return [];
    
    const origToNorm = [];
    let origIdx = 0;
    let normIdx = 0;
    
    while (origIdx < original.length && normIdx < normalized.length) {
        if (original[origIdx] === normalized[normIdx]) {
            origToNorm.push(normIdx);
            origIdx++;
            normIdx++;
        } else if ((original[origIdx] === ' ' || original[origIdx] === '\t') && normalized[normIdx] === ' ') {
            origToNorm.push(normIdx);
            origIdx++;
            if (origIdx < original.length && original[origIdx] !== ' ' && original[origIdx] !== '\t') {
                normIdx++;
            }
        } else if (original[origIdx] === ' ' || original[origIdx] === '\t') {
            origToNorm.push(normIdx);
            origIdx++;
        } else {
            origToNorm.push(normIdx);
            origIdx++;
        }
    }
    
    while (origIdx < original.length) {
        origToNorm.push(normalized.length);
        origIdx++;
    }
    
    const normToOrigStart = {};
    const normToOrigEnd = {};
    
    for (let origPos = 0; origPos < origToNorm.length; origPos++) {
        const normPos = origToNorm[origPos];
        if (normToOrigStart[normPos] === undefined) {
            normToOrigStart[normPos] = origPos;
        }
        normToOrigEnd[normPos] = origPos;
    }
    
    const originalMatches = [];
    for (const [normStart, normEnd] of normalizedMatches) {
        let origStart;
        if (normToOrigStart[normStart] !== undefined) {
            origStart = normToOrigStart[normStart];
        } else {
            let nearest = 0;
            for (let i = 0; i < origToNorm.length; i++) {
                if (origToNorm[i] >= normStart) {
                    nearest = i;
                    break;
                }
            }
            origStart = nearest;
        }
        
        let origEnd;
        if (normToOrigEnd[normEnd - 1] !== undefined) {
            origEnd = normToOrigEnd[normEnd - 1] + 1;
        } else {
            origEnd = origStart + (normEnd - normStart);
        }
        
        while (origEnd < original.length && (original[origEnd] === ' ' || original[origEnd] === '\t')) {
            origEnd++;
        }
        
        originalMatches.push([origStart, Math.min(origEnd, original.length)]);
    }
    
    return originalMatches;
}

function strategyIndentationFlexible(content, pattern) {
    const contentLines = content.split('\n');
    const contentStrippedLines = contentLines.map(l => l.trimStart());
    const patternLines = pattern.split('\n').map(l => l.trimStart());
    
    return findNormalizedMatches(content, contentLines, contentStrippedLines, pattern, patternLines.join('\n'));
}

function strategyEscapeNormalized(content, pattern) {
    const unescape = (s) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r');
    const patternUnescaped = unescape(pattern);
    if (patternUnescaped === pattern) return [];
    return strategyExact(content, patternUnescaped);
}

function strategyTrimmedBoundary(content, pattern) {
    const patternLines = pattern.split('\n');
    if (patternLines.length === 0) return [];
    
    patternLines[0] = patternLines[0].trim();
    if (patternLines.length > 1) {
        patternLines[patternLines.length - 1] = patternLines[patternLines.length - 1].trim();
    }
    
    const modifiedPattern = patternLines.join('\n');
    const contentLines = content.split('\n');
    const matches = [];
    const patternLineCount = patternLines.length;
    
    for (let i = 0; i <= contentLines.length - patternLineCount; i++) {
        const checkLines = contentLines.slice(i, i + patternLineCount);
        checkLines[0] = checkLines[0].trim();
        if (checkLines.length > 1) {
            checkLines[checkLines.length - 1] = checkLines[checkLines.length - 1].trim();
        }
        
        if (checkLines.join('\n') === modifiedPattern) {
            const [startPos, endPos] = calculateLinePositions(contentLines, i, i + patternLineCount, content.length);
            matches.push([startPos, endPos]);
        }
    }
    return matches;
}

function strategyUnicodeNormalized(content, pattern) {
    const normPattern = unicodeNormalize(pattern);
    const normContent = unicodeNormalize(content);
    if (normContent === content && normPattern === pattern) return [];
    
    let normMatches = strategyExact(normContent, normPattern);
    if (normMatches.length === 0) {
        normMatches = strategyLineTrimmed(normContent, normPattern);
    }
    if (normMatches.length === 0) return [];
    
    const origToNorm = buildOrigToNormMap(content);
    return mapPositionsNormToOrig(origToNorm, normMatches);
}

function strategyBlockAnchor(content, pattern) {
    const normPattern = unicodeNormalize(pattern);
    const normContent = unicodeNormalize(content);
    
    const patternLines = normPattern.split('\n');
    if (patternLines.length < 2) return [];
    
    const firstLine = patternLines[0].trim();
    const lastLine = patternLines[patternLines.length - 1].trim();
    
    const normContentLines = normContent.split('\n');
    const origContentLines = content.split('\n');
    const patternLineCount = patternLines.length;
    
    const potentialMatches = [];
    for (let i = 0; i <= normContentLines.length - patternLineCount; i++) {
        if (normContentLines[i].trim() === firstLine && 
            normContentLines[i + patternLineCount - 1].trim() === lastLine) {
            potentialMatches.push(i);
        }
    }
    
    const matches = [];
    const candidateCount = potentialMatches.length;
    const threshold = candidateCount === 1 ? 0.50 : 0.70;
    
    for (const i of potentialMatches) {
        let similarity = 1.0;
        if (patternLineCount > 2) {
            const contentMiddle = normContentLines.slice(i + 1, i + patternLineCount - 1).join('\n');
            const patternMiddle = patternLines.slice(1, -1).join('\n');
            similarity = getSequenceMatcherRatio(contentMiddle, patternMiddle);
        }
        
        if (similarity >= threshold) {
            const [startPos, endPos] = calculateLinePositions(origContentLines, i, i + patternLineCount, content.length);
            matches.push([startPos, endPos]);
        }
    }
    
    return matches;
}

function strategyContextAware(content, pattern) {
    const patternLines = pattern.split('\n');
    const contentLines = content.split('\n');
    if (patternLines.length === 0) return [];
    
    const matches = [];
    const patternLineCount = patternLines.length;
    
    for (let i = 0; i <= contentLines.length - patternLineCount; i++) {
        const blockLines = contentLines.slice(i, i + patternLineCount);
        
        let highSimilarityCount = 0;
        for (let j = 0; j < patternLineCount; j++) {
            const sim = getSequenceMatcherRatio(patternLines[j].trim(), blockLines[j].trim());
            if (sim >= 0.80) {
                highSimilarityCount++;
            }
        }
        
        if (highSimilarityCount >= patternLines.length * 0.5) {
            const [startPos, endPos] = calculateLinePositions(contentLines, i, i + patternLineCount, content.length);
            matches.push([startPos, endPos]);
        }
    }
    
    return matches;
}

function detectEscapeDrift(content, matches, oldString, newString) {
    if (!newString.includes("\\'") && !newString.includes('\\"')) {
        return null;
    }
    
    let matchedRegions = "";
    for (const [start, end] of matches) {
        matchedRegions += content.slice(start, end);
    }
    
    for (const suspect of ["\\'", '\\"']) {
        if (newString.includes(suspect) && oldString.includes(suspect) && !matchedRegions.includes(suspect)) {
            const plain = suspect[1];
            return `Escape-drift detected: old_string and new_string contain the literal sequence ${JSON.stringify(suspect)} but the matched region of the file does not. This is almost always a tool-call serialization artifact where an apostrophe or quote got prefixed with a spurious backslash. Re-read the file with read_file and pass old_string/new_string without backslash-escaping ${plain} characters.`;
        }
    }
    return null;
}

function applyReplacements(content, matches, newString) {
    const sortedMatches = [...matches].sort((a, b) => b[0] - a[0]);
    let result = content;
    for (const [start, end] of sortedMatches) {
        result = result.slice(0, start) + newString + result.slice(end);
    }
    return result;
}

function findClosestLines(oldString, content, contextLines = 2, maxResults = 3) {
    if (!oldString || !content) return "";
    const oldLines = oldString.split('\n');
    const contentLines = content.split('\n');
    if (oldLines.length === 0 || contentLines.length === 0) return "";
    
    let anchor = oldLines[0].trim();
    if (!anchor) {
        const candidates = oldLines.map(l => l.trim()).filter(Boolean);
        if (candidates.length === 0) return "";
        anchor = candidates[0];
    }
    
    const scored = [];
    for (let i = 0; i < contentLines.length; i++) {
        const stripped = contentLines[i].trim();
        if (!stripped) continue;
        const ratio = getSequenceMatcherRatio(anchor, stripped);
        if (ratio > 0.3) {
            scored.push({ ratio, idx: i });
        }
    }
    
    if (scored.length === 0) return "";
    
    scored.sort((a, b) => b.ratio - a.ratio);
    const top = scored.slice(0, maxResults);
    
    const parts = [];
    const seenRanges = new Set();
    
    for (const item of top) {
        const start = Math.max(0, item.idx - contextLines);
        const end = Math.min(contentLines.length, item.idx + oldLines.length + contextLines);
        const key = `${start}:${end}`;
        if (seenRanges.has(key)) continue;
        seenRanges.add(key);
        
        const snippetLines = [];
        for (let j = start; j < end; j++) {
            snippetLines.push(`${String(j + 1).padStart(4, ' ')}| ${contentLines[j]}`);
        }
        parts.push(snippetLines.join('\n'));
    }
    
    if (parts.length === 0) return "";
    return parts.join('\n---\n');
}

function formatNoMatchHint(error, matchCount, oldString, content) {
    if (matchCount !== 0) return "";
    if (!error || !error.startsWith("Could not find")) return "";
    const hint = findClosestLines(oldString, content);
    if (!hint) return "";
    return "\n\nDid you mean one of these sections?\n" + hint;
}

function fuzzyFindAndReplace(content, oldString, newString, replaceAll = false) {
    if (!oldString) {
        return [content, 0, null, "old_string cannot be empty"];
    }
    if (oldString === newString) {
        return [content, 0, null, "old_string and new_string are identical"];
    }
    
    const strategies = [
        ["exact", strategyExact],
        ["line_trimmed", strategyLineTrimmed],
        ["whitespace_normalized", strategyWhitespaceNormalized],
        ["indentation_flexible", strategyIndentationFlexible],
        ["escape_normalized", strategyEscapeNormalized],
        ["trimmed_boundary", strategyTrimmedBoundary],
        ["unicode_normalized", strategyUnicodeNormalized],
        ["block_anchor", strategyBlockAnchor],
        ["context_aware", strategyContextAware]
    ];
    
    for (const [name, fn] of strategies) {
        const matches = fn(content, oldString);
        if (matches && matches.length > 0) {
            if (matches.length > 1 && !replaceAll) {
                return [content, 0, null, `Found ${matches.length} matches for old_string. Provide more context to make it unique, or use replace_all=true.`];
            }
            
            const driftErr = detectEscapeDrift(content, matches, oldString, newString);
            if (driftErr) {
                return [content, 0, null, driftErr];
            }
            
            const newContent = applyReplacements(content, matches, newString);
            return [newContent, matches.length, name, null];
        }
    }
    
    return [content, 0, null, "Could not find a match for old_string in the file"];
}

module.exports = {
    fuzzyFindAndReplace,
    formatNoMatchHint,
    findClosestLines
};
