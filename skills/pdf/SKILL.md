---
name: pdf
description: "Professional PDF production: reports, visuals, academic, and processing."
category: document
trigger: "creating or processing PDF documents"
version: 1.0.0
author: August Proxy
license: MIT
---

# PDF Production

## Overview

Professional PDF document creation with four production pipelines. Each pipeline targets a different document type with the appropriate tooling.

> **Prerequisites:** Choose the pipeline that matches your document type and ensure the required tools are installed.

## Pipelines

### 1. Report Pipeline (ReportLab)

**For:** Structured documents, reports, invoices, forms
**Tool:** `reportlab` (Python)
**Install:** `pip install reportlab`

```python
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table
from reportlab.lib.styles import getSampleStyleSheet

doc = SimpleDocTemplate("report.pdf", pagesize=A4)
styles = getSampleStyleSheet()
story = []

story.append(Paragraph("Report Title", styles['Title']))
story.append(Spacer(1, 20))
story.append(Paragraph("Content here...", styles['Normal']))

doc.build(story)
```

### 2. Creative Pipeline (HTML + Playwright)

**For:** Posters, flyers, invitations, visual designs
**Tool:** Playwright for HTML-to-PDF
**Install:** `pip install playwright && playwright install`

Create an HTML file with your design, then convert:

```bash
python -c "
import asyncio
from playwright.async_api import async_playwright

async def convert():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()
        await page.goto('file://design.html')
        await page.pdf(path='output.pdf', format='A4')
        await browser.close()

asyncio.run(convert())
"
```

### 3. Academic Pipeline (LaTeX)

**For:** Papers, theses, mathematical documents
**Tool:** Tectonic or TeX Live
**Install:** Tectonic (`curl -fsSL https://tectonic-typesetting.github.io/install.sh | sh`)

Create a `.tex` file and compile:

```bash
tectonic paper.tex
```

### 4. Process Pipeline (Existing PDFs)

**For:** Extracting, merging, splitting, filling forms
**Tool:** `pypdf` or `pdfplumber` (Python)
**Install:** `pip install pypdf pdfplumber`

```python
# Merge PDFs
from pypdf import PdfWriter
merger = PdfWriter()
merger.append("file1.pdf")
merger.append("file2.pdf")
merger.write("merged.pdf")

# Extract text
import pdfplumber
with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        print(page.extract_text())
```

## Quality Checks

- [ ] All content is visible (no overflow or clipping)
- [ ] Page size is correct
- [ ] Fonts are embedded (if required)
- [ ] Hyperlinks work
- [ ] Table of contents matches actual content
- [ ] File size is reasonable

## Pipeline Selection Guide

| Document type | Pipeline |
|---------------|----------|
| Business report, invoice | ReportLab |
| Poster, flyer, invitation | Creative (HTML) |
| Research paper, thesis | LaTeX |
| Existing PDF processing | Process (pypdf) |
