"""Artifact judge — render produced documents to page images and run a
vision acceptance pass (the ZCode-style ``judge`` gate, August-native).

Two primitives, wired as tools in ``tool_registrations/artifact_tools``:

  * :func:`render_pages` — a ``.pdf``/``.pptx``/``.docx``/``.xlsx`` (or an
    image) becomes PNG page images under ``<dataDir>/render-cache``.
    Documents go through headless LibreOffice (``soffice`` on PATH or the
    common install locations); PDFs/pages render via pypdfium2. An
    ``.html``/``.svg`` artifact is screenshotted through the SHARED browser
    session from the Stage 1 artifact route (see :func:`render_pages_live`),
    so the judge sees exactly what the user sees — same CSP, same origin —
    instead of a second engine with no navigation guard.
  * :func:`judge_artifact` — renders (reusing render_pages) and asks the
    session's own vision model for a per-page ``pass/fail + issues``
    verdict against the user's request. The verdict is structured JSON the
    model acts on: fix the artifact, re-run the judge, ship only when
    ``overall`` says pass. This is a REVIEW step, not a withholding gate —
    the tool returns the verdict and the model decides (no answer is ever
    held back by it; see the 2026-08-24 no-gates ruling).

Reads bind through ``sandbox.paths.bind_path`` (workspace ∪ session roots);
PNG output goes to the app data dir, never the workspace, so judging leaves
no scratch files in the user's tree.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_DOC_EXT = ('.pptx', '.docx', '.xlsx', '.odp', '.ods', '.odt', '.ppt', '.doc', '.xls')
_IMG_EXT = ('.png', '.jpg', '.jpeg', '.webp')
_PDF_EXT = ('.pdf',)
# A live artifact document: the whole point of `create_html_artifact`, and
# the gap this module had — its output could not be judged at all.
_HTML_EXT = ('.html', '.htm', '.svg')
_JUDGE_PAGE_CAP = 8  # pages sent to the vision call in one pass
_DPI_MIN, _DPI_MAX = 72, 200
# One dedicated browser session for judging. It rides the shared engine (one
# headless chromium, no second launch) with the navigation guard installed
# and loopback permitted for THIS session only — the artifact route IS
# August's own backend. Never handed to a model-facing tool.
_JUDGE_BROWSER_SESSION = 'artifact-judge'


def find_soffice() -> str:
    """Path to a headless-capable LibreOffice binary, '' when none."""
    for exe in ('soffice', 'libreoffice'):
        found = shutil.which(exe)
        if found:
            return found
    for cand in _SOFFICE_CANDIDATES:
        if Path(cand).is_file():
            return str(cand)
    return ''


_SOFFICE_CANDIDATES = (
    'C:/Program Files/LibreOffice/program/soffice.exe',
    'C:/Program Files (x86)/LibreOffice/program/soffice.exe',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
)


def parse_pages_spec(spec: str, total: int) -> list[int]:
    """``'1-3,5'`` → ``[1,2,3,5]`` (1-based, clamped, deduped); ''/garbage →
    first ``_JUDGE_PAGE_CAP`` pages."""
    out: list[int] = []
    text = (spec or '').strip()
    if not text:
        return list(range(1, min(total, _JUDGE_PAGE_CAP) + 1))
    for chunk in text.split(','):
        chunk = chunk.strip()
        if not chunk:
            continue
        m = re.match(r'^(\d+)\s*-\s*(\d+)$', chunk)
        if m:
            lo, hi = int(m.group(1)), int(m.group(2))
        elif chunk.isdigit():
            lo = hi = int(chunk)
        else:
            continue
        for p in range(lo, hi + 1):
            if 1 <= p <= total and p not in out:
                out.append(p)
    return out or list(range(1, min(total, _JUDGE_PAGE_CAP) + 1))


def _cache_dir(src: Path) -> Path:
    digest = hashlib.sha1(
        f'{src}|{src.stat().st_size if src.exists() else 0}'.encode('utf-8')
    ).hexdigest()[:10]
    from app.lib.paths import dataPath

    d = dataPath('render-cache', f'{re.sub(r"[^a-z0-9_-]", "_", src.stem)[:32]}-{digest}')
    d.mkdir(parents=True, exist_ok=True)
    return d


def _convert_to_pdf(src: Path, out_dir: Path, timeout_s: int = 120) -> Path | None:
    soffice = find_soffice()
    if not soffice:
        return None
    try:
        subprocess.run(
            [
                soffice, '--headless', '--norestore', '--convert-to', 'pdf',
                '--outdir', str(out_dir), str(src),
            ],
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        logger.warning('artifact_judge: soffice convert failed: %s', exc)
        return None
    pdf = out_dir / (src.stem + '.pdf')
    return pdf if pdf.is_file() else None


def _render_pdf_pages(pdf: Path, selected: list[int], dpi: int, out_dir: Path) -> list[Path]:
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(pdf))
    try:
        total = len(doc)
        wanted = [p for p in selected if 1 <= p <= total]
        if not wanted:
            wanted = list(range(1, min(total, _JUDGE_PAGE_CAP) + 1))
        scale = max(_DPI_MIN, min(dpi, _DPI_MAX)) / 72.0
        out: list[Path] = []
        for p in wanted:
            page = doc[p - 1]
            try:
                bmp = page.render(scale=scale)
                pil = bmp.to_pil()
                target = out_dir / f'page-{p:02d}.png'
                pil.save(target, 'PNG')
                out.append(target)
            finally:
                page.close()
        return out
    finally:
        doc.close()


def _artifactRouteUrl(src: Path) -> str:
    """The Stage 1 route that serves this artifact as a live document.

    Not ``file://``: the judge must screenshot the document the same way the
    user's drawer does — from the backend origin, under the route's
    document-scoped CSP, where the artifact's inline script actually runs.
    A judge that screenshots a laxer rendering than the user sees would pass
    figures that are broken in the app.
    """
    from os import environ
    from urllib.parse import quote

    from app.services.browser.session_manager import artifactRoutePath

    port = environ.get('AUGUST_PROXY_PORT', '8085')
    # The same accessor the guard matches against: this URL and the carve-out
    # that permits it must not be two spellings of one path.
    return f'http://127.0.0.1:{port}{artifactRoutePath()}?path={quote(str(src))}'


async def _renderHtmlPages(src: Path, out_dir: Path, dpi: int) -> dict[str, Any]:
    """Screenshot an HTML/SVG artifact through the shared browser session.

    A judge-local ``async_playwright().start()`` would silently drop the
    navigation guard (``page.route`` never fires for 3xx hops; the re-check on
    the final URL is the control that closes the redirect case). This rides
    the existing engine instead — one chromium per session id, guard
    installed — with loopback permitted for the judge's own session only.

    Returns the render_pages shape: ``{ok, file, renderer, pageCount, rendered}``.
    An artifact document is one page; the ``pages`` spec does not apply.
    """
    from urllib.parse import urlparse

    from app.services.browser import session_manager as browser

    try:
        session = await browser.getOrCreateSession(_JUDGE_BROWSER_SESSION, allow_loopback=True)
    except browser.BrowserUnavailableError as exc:
        # The clean receipt from the probe — the judge reports it instead of
        # dying on Playwright's raw error.
        return {'ok': False, 'error': str(exc)}
    except Exception as exc:
        return {'ok': False, 'error': f'browser failed to start: {exc}'}
    page = session.page
    if page is None:
        return {'ok': False, 'error': 'browser session not ready'}

    url = _artifactRouteUrl(src)
    try:
        await page.goto(url, wait_until='load', timeout=30_000)
        if session.navBlockReason:
            return {'ok': False, 'error': f'navigation blocked: {session.navBlockReason}'}
        # One settle budget: an animated artifact needs a few frames to show
        # itself, and a settle figure is still at its rest pose. 400 ms is the
        # whole budget — this is a review pass, not a frame-accurate capture.
        await page.wait_for_timeout(400)
        # The document runs with `script-src 'unsafe-inline'`, so it can move
        # its own frame between the goto and the capture. Re-check where the
        # page ACTUALLY is, on the same predicate the request guard used, and
        # drop the screenshot if it moved — a refused navigation has still
        # executed script and still populated the DOM, so capturing it would
        # hand the vision model whatever the redirect returned.
        moved = browser.assertFinalUrlAllowed(page, session)
        if not moved and urlparse(page.url).path != browser.artifactRoutePath():
            moved = f'navigation left the artifact route: {page.url}'
        if moved:
            return {'ok': False, 'error': f'navigation blocked: {moved}'}
        shot = out_dir / 'page-01.png'
        await page.screenshot(path=str(shot), full_page=False)
    except Exception as exc:
        return {
            'ok': False,
            'error': (
                f'artifact page could not be screenshotted: {exc}. The judge needs the '
                'backend running and a chromium browser installed '
                '(`uv run playwright install chromium`).'
            ),
        }
    return {
        'ok': True,
        'file': str(src),
        'renderer': 'browser(chromium)',
        'pageCount': 1,
        'rendered': [str(shot)],
    }


async def render_pages_live(
    path: str, workspace: str = '', pages: str = '', dpi: int = 110
) -> dict[str, Any]:
    """Async front door of the render pipeline.

    ``.html``/``.htm``/``.svg`` go through the shared browser session from
    the artifact route; everything else defers to the synchronous
    :func:`render_pages` (LibreOffice/pypdfium2/image). Same return shape
    either way, so callers do not branch on the type.
    """
    from app.services.sandbox.paths import bind_path

    target = str(path or '').strip()
    if not target:
        raise ValueError('path is required (workspace document, PDF, image or HTML artifact path).')
    bound, err = bind_path(target, workspace or None, for_write=False)
    if err or not bound:
        raise ValueError(f'file not found / outside allowed roots: {target}')
    src = Path(bound)
    ext = src.suffix.lower()
    if ext not in _HTML_EXT:
        return render_pages(path, workspace=workspace, pages=pages, dpi=dpi)
    out_dir = _cache_dir(src)
    return await _renderHtmlPages(src, out_dir, int(dpi or 110))


def render_pages(path: str, workspace: str = '', pages: str = '', dpi: int = 110) -> dict[str, Any]:
    """Render a document to PNG page images in the app render cache.

    Returns ``{ok, file, renderer, pageCount, rendered: [abs png paths]}``
    or ``{ok: False, error: <actionable receipt>}``.
    """
    from app.services.sandbox.paths import bind_path

    target = str(path or '').strip()
    if not target:
        raise ValueError('path is required (workspace document or PDF path).')
    bound, err = bind_path(target, workspace or None, for_write=False)
    if err or not bound:
        raise ValueError(f'file not found / outside allowed roots: {target}')
    src = Path(bound)
    ext = src.suffix.lower()

    out_dir = _cache_dir(src)
    renderer = ''
    pdf_path: Path | None = None
    if ext in _PDF_EXT:
        pdf_path, renderer = src, 'pypdfium2'
    elif ext in _IMG_EXT:
        # An image is already a page — copy into the cache shape.
        flat = out_dir / 'page-01.png'
        if not flat.exists():
            shutil.copyfile(src, flat)
        return {
            'ok': True, 'file': str(src), 'renderer': 'image', 'pageCount': 1,
            'rendered': [str(flat)],
        }
    elif ext in _DOC_EXT:
        pdf_path = _convert_to_pdf(src, out_dir)
        renderer = 'libreoffice+pypdfium2'
        if pdf_path is None:
            return {
                'ok': False,
                'error': (
                    f'cannot render {ext} to pages: headless LibreOffice (soffice) was not '
                    'found on this machine. Install LibreOffice, export the document to PDF '
                    'yourself, and pass the PDF to render_pages / judge_artifact.'
                ),
            }
    else:
        raise ValueError(
            f'unsupported file type {ext!r} '
            '(pdf/pptx/docx/xlsx/odp/ods/odt/png/jpg/webp/html/htm/svg)'
        )

    try:
        import pypdfium2  # noqa: F401
    except Exception:
        return {'ok': False, 'error': 'pypdfium2 is not installed in this backend environment.'}

    total_probe = None
    try:
        import pypdfium2 as pdfium

        doc = pdfium.PdfDocument(str(pdf_path))
        total_probe = len(doc)
        doc.close()
    except Exception as exc:
        return {'ok': False, 'error': f'PDF could not be opened: {exc}'}

    selected = parse_pages_spec(pages, total_probe or 0)
    rendered = _render_pdf_pages(pdf_path, selected, int(dpi or 110), out_dir)
    if not rendered:
        return {'ok': False, 'error': 'PDF has no renderable pages.'}
    return {
        'ok': True, 'file': str(src), 'renderer': renderer, 'pageCount': total_probe,
        'rendered': [str(p) for p in rendered],
    }


_JUDGE_PROMPT = (
    'You are the visual acceptance reviewer for a produced document. The '
    'deliverable must fulfill the REQUEST below; judge EACH page image.\n'
    'REQUEST: {request}\n'
    '{rubric}'
    'Check: does the content fulfill the request (right topic/slide count/'
    'data); any layout defect (overlapping or cut-off text, elements off '
    'page, empty or broken charts/images, unreadable contrast); obvious '
    'typos or placeholder text left in.\n'
    'Return ONLY a JSON object, no prose:\n'
    '{{"overall": "pass" or "fix", "pages": [{{"page": <1-based number>, '
    '"pass": true|false, "issues": ["<specific defect + where>", ...]}}]}}\n'
    'A page with nothing wrong gets "pass": true and an empty issues list. '
    '"overall" is "pass" only if EVERY judged page passes.'
)


def _extract_json(text: str) -> dict[str, Any] | None:
    """First JSON object in a reply (tolerates code fences / lead-in prose)."""
    if not text:
        return None
    fenced = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', text, re.DOTALL)
    for cand in ([fenced.group(1)] if fenced else []) + [(text[text.find('{'): text.rfind('}') + 1]
                                                          if '{' in text and '}' in text else '')]:
        if not cand:
            continue
        try:
            obj = json.loads(cand)
            if isinstance(obj, dict):
                return obj
        except Exception:
            continue
    return None


async def judge_artifact(
    path: str,
    request: str,
    rubric: str = '',
    pages: str = '',
    workspace: str = '',
) -> dict[str, Any]:
    """Render the document's pages and run one vision acceptance pass.

    ``request`` = what the user asked the artifact to be (verbatim as
    practical). ``rubric`` = optional extra criteria. Returns
    ``{ok, overall, pages: [...], rendered, pageCount}`` or an error
    receipt. The verdict drives the model's repair loop — it never
    blocks an answer.
    """
    req = str(request or '').strip()
    if not req:
        raise ValueError('request is required — what the user asked this artifact to be.')
    # The async door, so an HTML/SVG artifact screenshots through the shared
    # browser session (same CSP, same origin as the user's drawer) instead of
    # falling through the document renderer with no pages at all.
    rendered = await render_pages_live(path, workspace=workspace, pages=pages)
    if not rendered.get('ok'):
        return rendered

    from app.services.tools.media_tools import _vision_describe

    pngs = list(rendered['rendered'])
    question = _JUDGE_PROMPT.format(
        request=req[:2000],
        rubric=(f'RUBRIC (user-specified): {rubric.strip()[:800]}\n' if (rubric or '').strip() else ''),
    )
    answer = await _vision_describe(pngs[0], question, extra_images=pngs[1:])
    verdict = _extract_json(answer)
    if verdict is None:
        return {
            'ok': False,
            'error': 'judge model reply carried no parseable verdict',
            'raw': answer[:1500],
            'rendered': pngs,
        }
    pages_v = verdict.get('pages')
    clean = []
    if isinstance(pages_v, list):
        for item in pages_v:
            if not isinstance(item, dict):
                continue
            raw_issues = item.get('issues')
            issues = raw_issues if isinstance(raw_issues, list) else []
            clean.append({
                'page': item.get('page'),
                'pass': bool(item.get('pass')),
                'issues': [str(i)[:300] for i in issues][:8],
            })
    overall = str(verdict.get('overall') or '').strip().lower()
    if overall not in ('pass', 'fix'):
        overall = 'pass' if clean and all(p['pass'] for p in clean) else 'fix'
    return {
        'ok': True,
        'overall': overall,
        'pages': clean,
        'pageCount': rendered.get('pageCount'),
        'rendered': pngs,
        'note': (
            'Acceptance verdict. Fix the listed issues in the artifact and '
            're-run judge_artifact until overall is "pass" before presenting '
            'the deliverable as done.'
        ),
    }
