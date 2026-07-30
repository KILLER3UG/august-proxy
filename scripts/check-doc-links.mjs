#!/usr/bin/env node
/**
 * check-doc-links.mjs — Verify all relative .md links resolve.
 *
 * Walks docs/ and root *.md files, extracts relative markdown links,
 * and verifies each target exists. Exit 1 with broken link list.
 *
 * Part of Better Harness Plan Phase 6.2.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function findMarkdownFiles(dir, depth = 0) {
  if (depth > 3) return [];
  const results = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.') || entry === 'node_modules' || entry === 'target') continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results.push(...findMarkdownFiles(full, depth + 1));
      } else if (entry.endsWith('.md')) {
        results.push(full);
      }
    }
  } catch { /* permission errors */ }
  return results;
}

function extractRelativeLinks(content) {
  const links = [];
  // Match [text](path) and [text](path "title")
  const regex = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const target = match[2].split('#')[0].split(' ')[0]; // Strip anchors and titles
    if (target && !target.startsWith('http') && !target.startsWith('mailto:') && !target.startsWith('<')) {
      links.push(target);
    }
  }
  return links;
}

// Scan docs/ and root .md files
const scanDirs = [join(root, 'docs')];
const rootMds = readdirSync(root).filter(f => f.endsWith('.md')).map(f => join(root, f));

const allFiles = [...rootMds];
for (const dir of scanDirs) {
  if (existsSync(dir)) allFiles.push(...findMarkdownFiles(dir));
}

const broken = [];
for (const file of allFiles) {
  const content = readFileSync(file, 'utf-8');
  const links = extractRelativeLinks(content);
  const fileDir = dirname(file);
  for (const link of links) {
    const target = resolve(fileDir, link);
    if (!existsSync(target)) {
      broken.push({ file: file.replace(root + '/', ''), link, target: target.replace(root + '/', '') });
    }
  }
}

if (broken.length === 0) {
  console.log(`✓ All ${allFiles.length} markdown files have valid relative links.`);
  process.exit(0);
} else {
  console.error(`ERROR: ${broken.length} broken link(s) found:\n`);
  for (const b of broken) {
    console.error(`  ${b.file} → ${b.link}`);
  }
  console.error(`\nFix or remove these links before committing.`);
  process.exit(1);
}
