---
name: pptx-author
description: Build PowerPoint decks with the create_pptx tool.
category: artifacts
---

# Authoring PowerPoint decks

Use the `create_pptx` tool — it writes a real .pptx into the workspace
(python-pptx under the hood) and the chat shows a downloadable file card.

## Workflow

1. Plan the deck as an outline first (title + 3-6 bullets per slide).
2. Call `create_pptx` once with the full slide list:

```json
{"path": "report.pptx", "slides": [
  {"title": "Quarterly Review", "bullets": ["Revenue +12%", "Churn flat"]},
  {"title": "Architecture", "bullets": ["Proxy layer", "Workbench"], "notes": "Speaker notes go here"}
]}
```

3. Each slide object accepts `title` (string), `bullets` (list of
   strings), and `notes` (speaker notes). A bare string becomes a
   section-title slide.
4. For charts inside the deck: render a PNG first with `render_chart`,
   then reference the image in your message (image slides land in a
   follow-up; today the PNG ships as its own file card).

## Rules of thumb

- One idea per slide; bullets are phrases, not paragraphs.
- Put the narrative in `notes`, not on the slide.
- Never hand-write OOXML or base64 — always use the tool.
