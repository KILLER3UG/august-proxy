"""PPTX element inspection + commenting tools (audit feature).

Hand-rolled OOXML via ``zipfile`` + ``lxml`` — no python-pptx dependency
(offline build). Comments are stored per-slide in ``ppt/comments/commentN.xml``
and anchored at the selected element's position in EMUs, with the comment
author list wired through ``[Content_Types].xml`` / presentation rels.

Element targeting contract (the "clearer guidance" the tools advertise):
  * ``pptx_list_elements`` reports every element's ``id`` (the drawing's
    ``cNvPr`` id), name, type, text, and position for a slide.
  * ``pptx_comment`` anchors the comment at the element's bounding-box
    origin — one comment per element per call; call ``pptx_list_elements``
    again to see the updated state.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any
from zipfile import ZIP_DEFLATED, ZipFile

from lxml import etree

logger = logging.getLogger(__name__)

# PresentationML namespace map (short prefixes used across the parts).
_NS = {
    'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'ct': 'http://schemas.openxmlformats.org/package/2006/content-types',
    'pr': 'http://schemas.openxmlformats.org/package/2006/relationships',
}

_COMMENT_AUTHORS_CT = 'application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml'
_COMMENTS_CT = 'application/vnd.openxmlformats-officedocument.presentationml.comments+xml'
_REL_COMMENT_AUTHORS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/commentAuthors'
_REL_COMMENTS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments'

_EMU_PER_INCH = 914400

# PPTX parts are untrusted input (user/model-created files) — parse with
# entity/network expansion disabled so a crafted file cannot XXE or
# billion-laughs the process.
_SECURE_PARSER = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False)


class PptxError(ValueError):
    """Raised for invalid PPTX files / targets (surfaced as tool errors)."""


def _parse(xml_bytes: bytes) -> etree._Element:
    try:
        return etree.fromstring(xml_bytes, parser=_SECURE_PARSER)  # noqa: S320 — hardened parser (resolve_entities=False)
    except etree.XMLSyntaxError as exc:
        raise PptxError(f'Malformed XML in pptx part: {exc}') from exc


def _serialize(root: etree._Element) -> bytes:
    return etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)


def _slide_paths(zf: ZipFile) -> list[str]:
    """Slide part paths in presentation order (from sldIdLst → rels)."""
    try:
        pres = _parse(zf.read('ppt/presentation.xml'))
    except KeyError as exc:
        raise PptxError('Not a PowerPoint file (missing ppt/presentation.xml)') from exc
    rels = _parse(zf.read('ppt/_rels/presentation.xml.rels'))
    id_to_target: dict[str, str] = {}
    for rel in rels:
        rid = rel.get('Id')
        target = rel.get('Target') or ''
        if rid:
            id_to_target[rid] = target
    order: list[str] = []
    sldIdLst = pres.find('p:sldIdLst', _NS)
    if sldIdLst is None:
        raise PptxError('Presentation has no slide list')
    for sldId in sldIdLst:
        rid = sldId.get('{%s}id' % _NS['r'])
        target = id_to_target.get(rid or '', '')
        if target:
            path = 'ppt/' + target.lstrip('/')
            if not path.endswith('.xml'):
                path += '.xml'
            if path in zf.namelist():
                order.append(path)
    if not order:
        # Fallback: any slideN.xml parts, sorted numerically.
        slides = [n for n in zf.namelist() if n.startswith('ppt/slides/slide') and n.endswith('.xml')]
        order = sorted(slides, key=lambda n: int(''.join(c for c in n.split('/')[-1] if c.isdigit())))
    return order


def _slide_size(zf: ZipFile) -> tuple[int, int]:
    """Slide dimensions in EMUs (cx, cy) — comment positions are clamped."""
    try:
        pres = _parse(zf.read('ppt/presentation.xml'))
    except KeyError:
        return (12192000, 6858000)  # 13.33x7.5in default
    sldSz = pres.find('p:sldSz', _NS)
    if sldSz is None:
        return (12192000, 6858000)
    cx = int(sldSz.get('cx') or 12192000)
    cy = int(sldSz.get('cy') or 6858000)
    return (cx, cy)


def _shape_type(el: etree._Element, ns: dict[str, str]) -> str:
    tag = etree.QName(el).localname
    if tag == 'pic':
        return 'picture'
    if tag == 'cxnSp':
        return 'connector'
    if tag == 'grpSp':
        return 'group'
    if tag == 'graphicFrame':
        graphicData = el.find('a:graphic/a:graphicData', ns)
        uri = graphicData.get('uri', '') if graphicData is not None else ''
        if 'table' in uri:
            return 'table'
        if 'chart' in uri:
            return 'chart'
        if 'smartArt' in uri:
            return 'smartArt'
        if 'oleObject' in uri:
            return 'embedded'
        return 'graphic'
    # p:sp — infer from the shape name (PowerPoint placeholders).
    cNvPr = el.find('p:nvSpPr/p:cNvPr', ns)
    name = ((cNvPr.get('name') if cNvPr is not None else '') or '').lower()
    if 'title' in name:
        return 'title'
    if 'subtitle' in name:
        return 'subtitle'
    if 'placeholder' in name or 'text box' in name or 'content' in name:
        return 'text'
    return 'shape'


def _shape_text(el: etree._Element, ns: dict[str, str]) -> str:
    texts = el.findall('.//a:t', ns)
    return ''.join((t.text or '') for t in texts).strip()


def _shape_pos(el: etree._Element, ns: dict[str, str]) -> tuple[int, int]:
    off = el.find('.//a:xfrm/a:off', ns)
    if off is None:
        return (0, 0)
    return (int(off.get('x') or 0), int(off.get('y') or 0))


def _walk_shapes(spTree: etree._Element, ns: dict[str, str], out: list[dict[str, Any]]) -> None:
    for el in spTree:
        tag = etree.QName(el).localname
        if tag not in ('sp', 'pic', 'cxnSp', 'graphicFrame', 'grpSp'):
            continue
        cNvPr = el.find('*/*/p:cNvPr', ns) or el.find('.//p:cNvPr', ns)
        if cNvPr is None:
            continue
        x, y = _shape_pos(el, ns)
        entry: dict[str, Any] = {
            'id': int(cNvPr.get('id') or 0),
            'name': cNvPr.get('name') or '',
            'type': _shape_type(el, ns),
            'text': _shape_text(el, ns)[:400],
            'pos': {'x': x, 'y': y},
        }
        out.append(entry)
        if tag == 'grpSp':
            _walk_shapes(el, ns, out)


def list_elements(path: str, slide: int | None = None) -> dict[str, Any]:
    """List slides + elements for ``path``.

    Returns ``{'ok': True, 'slides': [{index, name, elements: [...]}], ...}``
    or an error dict. ``slide`` (1-based) filters to a single slide.
    """
    try:
        with ZipFile(path) as zf:
            slide_paths = _slide_paths(zf)
            result: list[dict[str, Any]] = []
            for i, spath in enumerate(slide_paths, start=1):
                if slide is not None and i != slide:
                    continue
                root = _parse(zf.read(spath))
                spTree = root.find('p:cSld/p:spTree', _NS)
                elements: list[dict[str, Any]] = []
                if spTree is not None:
                    _walk_shapes(spTree, _NS, elements)
                result.append(
                    {
                        'index': i,
                        'name': spath.split('/')[-1].replace('.xml', ''),
                        'elementCount': len(elements),
                        'elements': elements,
                    }
                )
                if slide is not None:
                    break
            return {'ok': True, 'slides': result, 'totalSlides': len(slide_paths)}
    except (KeyError, OSError, PptxError) as exc:
        return {'ok': False, 'error': f'pptx_list_elements: {exc}'}


def _ensure_comments_part(zf: ZipFile, slide_index: int, elements: dict[int, etree._Element]) -> etree._Element:
    """Load (or create) the comment list part for a slide (1-based)."""
    name = f'ppt/comments/comment{slide_index}.xml'
    if name in zf.namelist():
        root = _parse(zf.read(name))
    else:
        root = etree.fromstring(  # noqa: S320 — self-constructed constant
            f'<p:cmLst xmlns:p="{_NS["p"]}"/>'.encode('utf-8')
        )
    return root


def _find_element_by_id(zf: ZipFile, slide_path: str, element_id: int) -> tuple[etree._Element, tuple[int, int]]:
    root = _parse(zf.read(slide_path))
    spTree = root.find('p:cSld/p:spTree', _NS)
    if spTree is None:
        raise PptxError(f'Slide {slide_path} has no shape tree')
    for el in spTree.iter():
        if etree.QName(el).localname != 'cNvPr':
            continue
        if int(el.get('id') or -1) == element_id:
            # cNvPr nests under p:nvSpPr — climb to the shape element so the
            # anchor position (a:xfrm/a:off) is read from the shape itself.
            shape: etree._Element | None = None
            node: Any = el.getparent()
            while node is not None and shape is None:
                if etree.QName(node).localname in ('sp', 'pic', 'cxnSp', 'graphicFrame', 'grpSp'):
                    shape = node
                node = node.getparent()
            if shape is None:
                break
            x, y = _shape_pos(shape, _NS)
            return shape, (x, y)
    raise PptxError(
        f'Element id {element_id} not found on this slide. '
        'Call pptx_list_elements first and use an id from its output.'
    )


def add_comment(path: str, slide: int, elementId: int, comment: str) -> dict[str, Any]:
    """Add a comment anchored at a slide element's position (OOXML comment part).

    Wires all five parts: the per-slide ``comments/commentN.xml``, the
    ``commentAuthors.xml`` list, ``[Content_Types].xml`` overrides, the
    presentation rels, the slide rels, and ``p:cmAuthorLstIdLst`` in the
    presentation part.
    """
    text = (comment or '').strip()
    if not text:
        return {'ok': False, 'error': 'pptx_comment: comment text is required'}
    try:
        slide = int(slide)
        elementId = int(elementId)
    except (TypeError, ValueError):
        return {'ok': False, 'error': 'pptx_comment: slide and elementId must be integers'}
    try:
        with ZipFile(path) as zf:
            slide_paths = _slide_paths(zf)
            if slide < 1 or slide > len(slide_paths):
                return {'ok': False, 'error': f'pptx_comment: slide {slide} out of range (1..{len(slide_paths)})'}
            slide_path = slide_paths[slide - 1]
            el, (x, y) = _find_element_by_id(zf, slide_path, elementId)
            cx, cy = _slide_size(zf)
            px = max(0, min(x, cx - 1))
            py = max(0, min(y, cy - 1))
            # Comment author list (created once, id 0 = "August").
            author_root = etree.fromstring(  # noqa: S320 — self-constructed constant
                f'<p:cmAuthorLst xmlns:p="{_NS["p"]}"/>'.encode('utf-8')
            )
            etree.SubElement(
                author_root, f'{{{_NS["p"]}}}cmAuthor',
                {'id': '0', 'name': 'August', 'initials': 'A', 'lastIdx': '0', 'clrIdx': '0'},
            )
            # Per-slide comment list (append; idx continues from existing).
            comments_root = _ensure_comments_part(zf, slide, {})
            existing_idx = [int(c.get('idx') or 0) for c in comments_root]
            idx = (max(existing_idx) + 1) if existing_idx else 1
            cm = etree.SubElement(
                comments_root, f'{{{_NS["p"]}}}cm',
                {'authorId': '0', 'dt': datetime.now(timezone.utc).isoformat(), 'idx': str(idx)},
            )
            etree.SubElement(cm, f'{{{_NS["p"]}}}pos', {'x': str(px), 'y': str(py)})
            etree.SubElement(cm, f'{{{_NS["p"]}}}text').text = text

            # Collect modified/new parts keyed by archive name.
            parts: dict[str, bytes] = {}
            parts['ppt/commentAuthors.xml'] = _serialize(author_root)
            parts[f'ppt/comments/comment{slide}.xml'] = _serialize(comments_root)
            parts['ppt/presentation.xml'] = _with_cm_author_lst(zf.read('ppt/presentation.xml'))
            parts['[Content_Types].xml'] = _with_content_type_overrides(
                zf.read('[Content_Types].xml'), slide
            )
            parts['ppt/_rels/presentation.xml.rels'] = _with_comment_authors_rel(
                zf.read('ppt/_rels/presentation.xml.rels')
            )
            rel_path = f'ppt/slides/_rels/{slide_path.split("/")[-1]}.rels'
            # Degenerate files can omit the slide rels part — create it then.
            rels_bytes = zf.read(rel_path) if rel_path in zf.namelist() else None
            parts[rel_path] = _with_slide_comments_rel(rels_bytes, slide)
        _rewrite_zip(path, parts)
        return {
            'ok': True,
            'slide': slide,
            'elementId': elementId,
            'commentId': idx,
            'anchor': {'x': px, 'y': py},
            'note': 'Comment added. Re-list elements to see further targets.',
        }
    except (KeyError, OSError, PptxError, ValueError) as exc:
        return {'ok': False, 'error': f'pptx_comment: {exc}'}


def _with_cm_author_lst(presentation_xml: bytes) -> bytes:
    root = _parse(presentation_xml)
    if root.find('p:cmAuthorLstIdLst', _NS) is None:
        lst = etree.SubElement(root, f'{{{_NS["p"]}}}cmAuthorLstIdLst')
        etree.SubElement(lst, f'{{{_NS["p"]}}}cmAuthorId', {'id': '0'})
    return _serialize(root)


def _with_content_type_overrides(content_types_xml: bytes, slide: int) -> bytes:
    root = _parse(content_types_xml)
    # Types > Default / Override entries are DIRECT children of the root —
    # no <Overrides> wrapper exists in the OOXML content-types part.
    existing = {o.get('PartName') for o in root}
    if '/ppt/commentAuthors.xml' not in existing:
        etree.SubElement(
            root, f'{{{_NS["ct"]}}}Override',
            {'PartName': '/ppt/commentAuthors.xml', 'ContentType': _COMMENT_AUTHORS_CT},
        )
    comment_name = f'/ppt/comments/comment{slide}.xml'
    if comment_name not in existing:
        etree.SubElement(
            root, f'{{{_NS["ct"]}}}Override',
            {'PartName': comment_name, 'ContentType': _COMMENTS_CT},
        )
    return _serialize(root)


def _with_comment_authors_rel(pres_rels_xml: bytes) -> bytes:
    root = _parse(pres_rels_xml)
    existing = {rel.get('Type') for rel in root}
    if _REL_COMMENT_AUTHORS not in existing:
        rid = _fresh_rel_id(root)
        etree.SubElement(
            root, f'{{{_NS["pr"]}}}Relationship',
            {'Id': rid, 'Type': _REL_COMMENT_AUTHORS, 'Target': 'comments/commentAuthors.xml'},
        )
    return _serialize(root)


def _with_slide_comments_rel(slide_rels_xml: bytes | None, slide: int) -> bytes:
    if slide_rels_xml is None:
        root = etree.fromstring(f'<Relationships xmlns="{_NS["pr"]}"/>'.encode('utf-8'))  # noqa: S320 — self-constructed constant
    else:
        root = _parse(slide_rels_xml)
    existing = {rel.get('Type') for rel in root}
    if _REL_COMMENTS not in existing:
        rid = _fresh_rel_id(root)
        etree.SubElement(
            root, f'{{{_NS["pr"]}}}Relationship',
            {'Id': rid, 'Type': _REL_COMMENTS, 'Target': f'../comments/comment{slide}.xml'},
        )
    return _serialize(root)


def _fresh_rel_id(rels_root: etree._Element) -> str:
    used = {rel.get('Id') for rel in rels_root}
    i = 1
    while f'rIdComment{i}' in used:
        i += 1
    return f'rIdComment{i}'


def _rewrite_zip(path: str, modified_parts: dict[str, bytes]) -> None:
    """Rewrite the pptx preserving every entry, replacing modified parts and
    ADDING new parts (comments/commentN.xml, commentAuthors.xml) — the old
    loop only copied existing entries, silently dropping new parts."""
    tmp = f'{path}.tmp-{uuid.uuid4().hex[:8]}'
    with ZipFile(path) as zin, ZipFile(tmp, 'w', ZIP_DEFLATED) as zout:
        written: set[str] = set()
        for item in zin.infolist():
            data = modified_parts.get(item.filename)
            if data is None:
                data = zin.read(item.filename)
            zout.writestr(item, data)
            written.add(item.filename)
        for name, data in modified_parts.items():
            if name not in written:
                zout.writestr(name, data)
    import os

    os.replace(tmp, path)
