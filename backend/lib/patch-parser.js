const { fuzzyFindAndReplace, formatNoMatchHint } = require('../services/memory/fuzzy-match');

const OperationType = {
    ADD: 'add',
    UPDATE: 'update',
    DELETE: 'delete',
    MOVE: 'move'
};

class HunkLine {
    constructor(prefix, content) {
        this.prefix = prefix; // ' ', '-', '+'
        this.content = content;
    }
}

class Hunk {
    constructor(contextHint = null) {
        this.context_hint = contextHint;
        this.lines = []; // HunkLine[]
    }
}

class PatchOperation {
    constructor(operation, filePath) {
        this.operation = operation; // OperationType
        this.file_path = filePath;
        this.new_path = null; // for MOVE
        this.hunks = []; // Hunk[]
    }
}

function parseV4APatch(patchContent) {
    const lines = patchContent.split(/\r?\n/);
    const operations = [];
    
    let startIdx = null;
    let endIdx = null;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('*** Begin Patch') || line.includes('***Begin Patch')) {
            startIdx = i;
        } else if (line.includes('*** End Patch') || line.includes('***End Patch')) {
            endIdx = i;
            break;
        }
    }
    
    if (startIdx === null) {
        startIdx = -1;
    }
    if (endIdx === null) {
        endIdx = lines.length;
    }
    
    let i = startIdx + 1;
    let currentOp = null;
    let currentHunk = null;
    
    while (i < endIdx) {
        const line = lines[i];
        
        const updateMatch = line.match(/^\*\*\*\s*Update\s+File:\s*(.+)$/i);
        const addMatch = line.match(/^\*\*\*\s*Add\s+File:\s*(.+)$/i);
        const deleteMatch = line.match(/^\*\*\*\s*Delete\s+File:\s*(.+)$/i);
        const moveMatch = line.match(/^\*\*\*\s*Move\s+File:\s*(.+?)\s*->\s*(.+)$/i);
        
        if (updateMatch) {
            if (currentOp) {
                if (currentHunk && currentHunk.lines.length > 0) {
                    currentOp.hunks.push(currentHunk);
                }
                operations.push(currentOp);
            }
            currentOp = new PatchOperation(OperationType.UPDATE, updateMatch[1].trim());
            currentHunk = null;
        } else if (addMatch) {
            if (currentOp) {
                if (currentHunk && currentHunk.lines.length > 0) {
                    currentOp.hunks.push(currentHunk);
                }
                operations.push(currentOp);
            }
            currentOp = new PatchOperation(OperationType.ADD, addMatch[1].trim());
            currentHunk = new Hunk();
        } else if (deleteMatch) {
            if (currentOp) {
                if (currentHunk && currentHunk.lines.length > 0) {
                    currentOp.hunks.push(currentHunk);
                }
                operations.push(currentOp);
            }
            currentOp = new PatchOperation(OperationType.DELETE, deleteMatch[1].trim());
            operations.push(currentOp);
            currentOp = null;
            currentHunk = null;
        } else if (moveMatch) {
            if (currentOp) {
                if (currentHunk && currentHunk.lines.length > 0) {
                    currentOp.hunks.push(currentHunk);
                }
                operations.push(currentOp);
            }
            currentOp = new PatchOperation(OperationType.MOVE, moveMatch[1].trim());
            currentOp.new_path = moveMatch[2].trim();
            operations.push(currentOp);
            currentOp = null;
            currentHunk = null;
        } else if (line.startsWith('@@')) {
            if (currentOp) {
                if (currentHunk && currentHunk.lines.length > 0) {
                    currentOp.hunks.push(currentHunk);
                }
                const hintMatch = line.match(/^@@\s*(.+?)\s*@@/);
                const hint = hintMatch ? hintMatch[1] : null;
                currentHunk = new Hunk(hint);
            }
        } else if (currentOp && line) {
            if (!currentHunk) {
                currentHunk = new Hunk();
            }
            
            if (line.startsWith('+')) {
                currentHunk.lines.push(new HunkLine('+', line.slice(1)));
            } else if (line.startsWith('-')) {
                currentHunk.lines.push(new HunkLine('-', line.slice(1)));
            } else if (line.startsWith(' ')) {
                currentHunk.lines.push(new HunkLine(' ', line.slice(1)));
            } else if (line.startsWith('\\')) {
                // skip "\ No newline at end of file"
            } else {
                currentHunk.lines.push(new HunkLine(' ', line));
            }
        }
        
        i++;
    }
    
    if (currentOp) {
        if (currentHunk && currentHunk.lines.length > 0) {
            currentOp.hunks.push(currentHunk);
        }
        operations.push(currentOp);
    }
    
    const parseErrors = [];
    for (const op of operations) {
        if (!op.file_path) {
            parseErrors.push("Operation with empty file path");
        }
        if (op.operation === OperationType.UPDATE && op.hunks.length === 0) {
            parseErrors.push(`UPDATE ${op.file_path}: no hunks found`);
        }
        if (op.operation === OperationType.MOVE && !op.new_path) {
            parseErrors.push(`MOVE ${op.file_path}: missing destination path`);
        }
    }
    
    if (parseErrors.length > 0) {
        return { operations: [], error: "Parse error: " + parseErrors.join("; ") };
    }
    
    return { operations, error: null };
}

function countOccurrences(text, pattern) {
    let count = 0;
    let pos = text.indexOf(pattern);
    while (pos !== -1) {
        count++;
        pos = text.indexOf(pattern, pos + 1);
    }
    return count;
}

function validateOperations(operations, fileOps) {
    const errors = [];
    
    for (const op of operations) {
        if (op.operation === OperationType.UPDATE) {
            const readResult = fileOps.read_file_raw(op.file_path);
            if (readResult.error) {
                errors.push(`${op.file_path}: ${readResult.error}`);
                continue;
            }
            
            let simulated = readResult.content;
            for (const hunk of op.hunks) {
                const searchLines = hunk.lines.filter(l => l.prefix === ' ' || l.prefix === '-').map(l => l.content);
                if (searchLines.length === 0) {
                    if (hunk.context_hint) {
                        const occurrences = countOccurrences(simulated, hunk.context_hint);
                        if (occurrences === 0) {
                            errors.push(`${op.file_path}: addition-only hunk context hint '${hunk.context_hint}' not found`);
                        } else if (occurrences > 1) {
                            errors.push(`${op.file_path}: addition-only hunk context hint '${hunk.context_hint}' is ambiguous (${occurrences} occurrences)`);
                        }
                    }
                    continue;
                }
                
                const searchPattern = searchLines.join('\n');
                const replaceLines = hunk.lines.filter(l => l.prefix === ' ' || l.prefix === '+').map(l => l.content);
                const replacement = replaceLines.join('\n');
                
                const [newSimulated, count, strategy, matchError] = fuzzyFindAndReplace(
                    simulated, searchPattern, replacement, false
                );
                
                if (count === 0) {
                    const label = hunk.context_hint ? `'${hunk.context_hint}'` : "(no hint)";
                    let msg = `${op.file_path}: hunk ${label} not found${matchError ? ` — ${matchError}` : ""}`;
                    const hint = formatNoMatchHint(matchError, count, searchPattern, simulated);
                    if (hint) {
                        msg += hint;
                    }
                    errors.push(msg);
                } else {
                    simulated = newSimulated;
                }
            }
        } else if (op.operation === OperationType.DELETE) {
            const readResult = fileOps.read_file_raw(op.file_path);
            if (readResult.error) {
                errors.push(`${op.file_path}: file not found for deletion`);
            }
        } else if (op.operation === OperationType.MOVE) {
            if (!op.new_path) {
                errors.push(`${op.file_path}: MOVE operation missing destination path`);
                continue;
            }
            const srcResult = fileOps.read_file_raw(op.file_path);
            if (srcResult.error) {
                errors.push(`${op.file_path}: source file not found for move`);
            }
            const dstResult = fileOps.read_file_raw(op.new_path);
            if (!dstResult.error) {
                errors.push(`${op.new_path}: destination already exists — move would overwrite`);
            }
        }
    }
    
    return errors;
}

function applyV4AOperations(operations, fileOps) {
    const validationErrors = validateOperations(operations, fileOps);
    if (validationErrors.length > 0) {
        return {
            success: false,
            error: "Patch validation failed (no files were modified):\n" + validationErrors.map(e => `  • ${e}`).join('\n')
        };
    }
    
    const filesModified = [];
    const filesCreated = [];
    const filesDeleted = [];
    const allDiffs = [];
    const errors = [];
    
    for (const op of operations) {
        try {
            if (op.operation === OperationType.ADD) {
                const contentLines = [];
                for (const hunk of op.hunks) {
                    for (const line of hunk.lines) {
                        if (line.prefix === '+') {
                            contentLines.push(line.content);
                        }
                    }
                }
                const content = contentLines.join('\n');
                const result = fileOps.write_file(op.file_path, content);
                if (result.error) {
                    errors.push(`Failed to add ${op.file_path}: ${result.error}`);
                } else {
                    filesCreated.push(op.file_path);
                    let diffContent = `--- /dev/null\n+++ b/${op.file_path}\n` + contentLines.map(line => `+${line}`).join('\n');
                    allDiffs.push(diffContent);
                }
            } else if (op.operation === OperationType.DELETE) {
                const readResult = fileOps.read_file_raw(op.file_path);
                if (readResult.error) {
                    errors.push(`Cannot delete ${op.file_path}: file not found`);
                } else {
                    const result = fileOps.delete_file(op.file_path);
                    if (result.error) {
                        errors.push(`Failed to delete ${op.file_path}: ${result.error}`);
                    } else {
                        filesDeleted.push(op.file_path);
                        const removedLines = readResult.content.split('\n');
                        let diffContent = `--- a/${op.file_path}\n+++ /dev/null\n` + removedLines.map(line => `-${line}`).join('\n');
                        allDiffs.push(diffContent);
                    }
                }
            } else if (op.operation === OperationType.MOVE) {
                const result = fileOps.move_file(op.file_path, op.new_path);
                if (result.error) {
                    errors.push(`Failed to move ${op.file_path}: ${result.error}`);
                } else {
                    filesModified.push(`${op.file_path} -> ${op.new_path}`);
                    allDiffs.push(`# Moved: ${op.file_path} -> ${op.new_path}`);
                }
            } else if (op.operation === OperationType.UPDATE) {
                const readResult = fileOps.read_file_raw(op.file_path);
                if (readResult.error) {
                    errors.push(`Cannot read file: ${readResult.error}`);
                    continue;
                }
                
                const currentContent = readResult.content;
                let newContent = currentContent;
                let updateFailed = false;
                
                for (const hunk of op.hunks) {
                    const searchLines = [];
                    const replaceLines = [];
                    
                    for (const line of hunk.lines) {
                        if (line.prefix === ' ') {
                            searchLines.push(line.content);
                            replaceLines.push(line.content);
                        } else if (line.prefix === '-') {
                            searchLines.push(line.content);
                        } else if (line.prefix === '+') {
                            replaceLines.push(line.content);
                        }
                    }
                    
                    if (searchLines.length > 0) {
                        const searchPattern = searchLines.join('\n');
                        const replacement = replaceLines.join('\n');
                        
                        let [tempContent, count, strategy, error] = fuzzyFindAndReplace(
                            newContent, searchPattern, replacement, false
                        );
                        
                        if (error && count === 0) {
                            if (hunk.context_hint) {
                                const hintPos = newContent.indexOf(hunk.context_hint);
                                if (hintPos !== -1) {
                                    const windowStart = Math.max(0, hintPos - 500);
                                    const windowEnd = Math.min(newContent.length, hintPos + 2000);
                                    const window = newContent.slice(windowStart, windowEnd);
                                    
                                    const [windowNew, wCount, wStrategy, wError] = fuzzyFindAndReplace(
                                        window, searchPattern, replacement, false
                                    );
                                    
                                    if (wCount > 0) {
                                        newContent = newContent.slice(0, windowStart) + windowNew + newContent.slice(windowEnd);
                                        error = null;
                                    }
                                }
                            }
                        } else {
                            newContent = tempContent;
                        }
                        
                        if (error) {
                            let errMsg = `Could not apply hunk: ${error}`;
                            const hint = formatNoMatchHint(error, 0, searchPattern, newContent);
                            if (hint) {
                                errMsg += hint;
                            }
                            errors.push(errMsg);
                            updateFailed = true;
                            break;
                        }
                    } else {
                        const insertText = replaceLines.join('\n');
                        if (hunk.context_hint) {
                            const occurrences = countOccurrences(newContent, hunk.context_hint);
                            if (occurrences === 0) {
                                newContent = newContent.replace(/\r?\n$/, '') + '\n' + insertText + '\n';
                            } else if (occurrences > 1) {
                                errors.push(`Addition-only hunk: context hint '${hunk.context_hint}' is ambiguous (${occurrences} occurrences) — provide a more unique hint`);
                                updateFailed = true;
                                break;
                            } else {
                                const hintPos = newContent.indexOf(hunk.context_hint);
                                const eol = newContent.indexOf('\n', hintPos);
                                if (eol !== -1) {
                                    newContent = newContent.slice(0, eol + 1) + insertText + '\n' + newContent.slice(eol + 1);
                                } else {
                                    newContent = newContent + '\n' + insertText;
                                }
                            }
                        } else {
                            newContent = newContent.replace(/\r?\n$/, '') + '\n' + insertText + '\n';
                        }
                    }
                }
                
                if (updateFailed) {
                    continue;
                }
                
                const writeResult = fileOps.write_file(op.file_path, newContent);
                if (writeResult.error) {
                    errors.push(`Failed to update ${op.file_path}: ${writeResult.error}`);
                } else {
                    filesModified.push(op.file_path);
                    allDiffs.push(`# Updated: ${op.file_path}`);
                }
            }
        } catch (e) {
            errors.push(`Error processing ${op.file_path}: ${e.message}`);
        }
    }
    
    const combinedDiff = allDiffs.join('\n');
    
    if (errors.length > 0) {
        return {
            success: false,
            diff: combinedDiff,
            files_modified: filesModified,
            files_created: filesCreated,
            files_deleted: filesDeleted,
            error: "Apply phase failed:\n" + errors.map(e => `  • ${e}`).join('\n')
        };
    }
    
    return {
        success: true,
        diff: combinedDiff,
        files_modified: filesModified,
        files_created: filesCreated,
        files_deleted: filesDeleted,
        error: null
    };
}

module.exports = {
    parseV4APatch,
    applyV4AOperations,
    OperationType
};
