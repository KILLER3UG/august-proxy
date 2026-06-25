---
name: docx
description: "Create, edit, and analyze DOCX documents with formatting and revisions."
trigger: "working with Word documents or DOCX files"
version: 1.0.0
author: August Proxy
license: MIT
---

# DOCX Document Creation

## Overview

Create, edit, format, and extract content from DOCX (Word) documents. This skill covers document creation, content modification, formatting, revision tracking, and text extraction.

> **Prerequisites:** This skill requires the `python-docx` library. Install with: `pip install python-docx`

## Workflow

### 1. Determine Task Type

Identify what needs to be done:

| Type | Description |
|------|-------------|
| **Create** | New document from scratch or from a template |
| **Edit** | Modify existing document content or formatting |
| **Format** | Apply styles, headings, tables, lists, page layout |
| **Read** | Extract text, analyze structure, review content |

### 2. Execute

#### Creating a Document

```python
from docx import Document
from docx.shared import Inches, Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()

# Add heading
doc.add_heading('Document Title', level=0)

# Add paragraph with formatting
p = doc.add_paragraph()
run = p.add_run('Bold text')
run.bold = True
run.font.size = Pt(12)

# Add table
table = doc.add_table(rows=3, cols=2)
table.style = 'Light Grid Accent 1'

# Save
doc.save('output.docx')
```

#### Editing an Existing Document

```python
from docx import Document

doc = Document('existing.docx')

# Find and replace text
for paragraph in doc.paragraphs:
    if 'old_text' in paragraph.text:
        for run in paragraph.runs:
            if 'old_text' in run.text:
                run.text = run.text.replace('old_text', 'new_text')

# Add content to existing document
doc.add_paragraph('Appended content')

doc.save('modified.docx')
```

#### Reading and Analysis

```python
from docx import Document

doc = Document('document.docx')

# Extract all text
for paragraph in doc.paragraphs:
    print(paragraph.text)

# Extract tables
for table in doc.tables:
    for row in table.rows:
        for cell in row.cells:
            print(cell.text)

# Analyze document structure
for i, paragraph in enumerate(doc.paragraphs):
    if paragraph.style.name.startswith('Heading'):
        print(f"Level {paragraph.style.name}: {paragraph.text}")
```

### 3. Quality Check

- [ ] Headings are properly nested (no level jumps)
- [ ] Table formatting is consistent
- [ ] All placeholders are replaced
- [ ] Page breaks are where expected
- [ ] Document opens without errors

## Common Patterns

| Task | python-docx Approach |
|------|---------------------|
| Add heading | `doc.add_heading('Text', level=N)` |
| Add paragraph | `doc.add_paragraph('Text')` |
| Add table | `doc.add_table(rows=N, cols=N)` |
| Add image | `doc.add_picture('path.png', width=Inches(6))` |
| Set margins | `section.left_margin = Cm(2.5)` |
| Page break | `doc.add_page_break()` |
| Bold / italic | `run.bold = True` / `run.italic = True` |
