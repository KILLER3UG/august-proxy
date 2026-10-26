/* ── svg-figure — sanitized inline SVG figures for chat markdown ───────
 *
 * Models write a fenced ```svg block for diagrams. Raw HTML in model output
 * is escaped by ChatMarkdown, so this is the one door a diagram may enter
 * through; everything below exists to make that door safe:
 *
 *   • allow-list tags/attributes (no script, style, foreignObject, image,
 *     use, animation, or external references);
 *   • prefix every id and url(#id) so one figure cannot address another
 *     figure or the app's own DOM;
 *   • no event-handler attributes, no style/class attributes.
 *
 * The figure wrapper adds the reference's hover menu (copy as image, download
 * SVG, download PNG). Exports re-resolve the theme's computed colors because
 * the on-screen SVG inherits app CSS that a downloaded file would not.
 */

import { COPY_ICON_SVG } from '@/lib/icons';

const SVG_NS = 'http://www.w3.org/2000/svg';

const ALLOWED_TAGS = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse',
  'line', 'polyline', 'polygon', 'text', 'tspan', 'marker', 'lineargradient',
  'radialgradient', 'stop', 'clippath',
]);

const DROP_TAGS = new Set([
  'script', 'style', 'foreignobject', 'iframe', 'object', 'embed', 'image',
  'use', 'a', 'animate', 'animatemotion', 'animatetransform', 'set', 'feimage',
  'filter', 'mask', 'pattern', 'symbol',
]);

const ALLOWED_ATTRS = new Set([
  'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'width', 'height', 'points', 'viewbox', 'preserveaspectratio', 'transform',
  'gradientunits', 'gradienttransform', 'offset', 'stop-color', 'stop-opacity',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity',
  'opacity', 'font-family', 'font-size', 'font-weight', 'font-style',
  'text-anchor', 'dominant-baseline', 'alignment-baseline', 'letter-spacing',
  'marker-start', 'marker-mid', 'marker-end', 'markerwidth', 'markerheight',
  'refx', 'refy', 'orient', 'markerunits', 'clip-path', 'id',
  'aria-labelledby', 'role', 'aria-label',
]);

const URL_REF = /url\(\s*#([^)\s]+)\s*\)/g;
const MAX_SVG_CHARS = 200_000;
const MAX_SVG_DEPTH = 40;
const MAX_SVG_NODES = 6_000;

interface SanitizeBudget {
  nodes: number;
}

function hash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

function copyAttributes(source: Element, target: Element, prefix: string): void {
  for (const attr of Array.from(source.attributes)) {
    const lower = attr.name.toLowerCase();
    if (lower.startsWith('on') || lower === 'style' || lower === 'class') continue;
    if (lower === 'href' || lower === 'xlink:href') continue;
    if (!ALLOWED_ATTRS.has(lower)) continue;
    let value = attr.value;
    if (value.length > 8000) continue;
    if (lower === 'id') {
      target.setAttribute('id', `${prefix}${value.replace(/[^A-Za-z0-9_.-]/g, '_')}`);
      continue;
    }
    if (lower === 'aria-labelledby') {
      target.setAttribute(
        'aria-labelledby',
        value.split(/\s+/).filter(Boolean).map((id) => `${prefix}${id}`).join(' '),
      );
      continue;
    }
    // Local paint/reference URLs are allowed; any other url() (http, data,
    // javascript) is an external fetch or an execution attempt.
    const withoutLocalRefs = value.replace(URL_REF, '');
    if (/url\s*\(/i.test(withoutLocalRefs) || /javascript:/i.test(value)) continue;
    value = value.replace(URL_REF, (_match, id: string) => `url(#${prefix}${id})`);
    target.setAttribute(attr.name, value);
  }
}

function sanitizeInto(
  source: Node,
  target: Element,
  prefix: string,
  depth: number,
  budget: SanitizeBudget,
): void {
  if (depth > MAX_SVG_DEPTH || budget.nodes <= 0) return;
  if (source.nodeType === Node.TEXT_NODE) {
    target.appendChild(document.createTextNode(source.nodeValue ?? ''));
    return;
  }
  if (source.nodeType !== Node.ELEMENT_NODE) return;
  const element = source as Element;
  const tag = element.tagName.toLowerCase();
  if (DROP_TAGS.has(tag)) return;
  budget.nodes -= 1;
  if (!ALLOWED_TAGS.has(tag)) {
    for (const child of Array.from(element.childNodes)) {
      sanitizeInto(child, target, prefix, depth + 1, budget);
    }
    return;
  }
  const out = document.createElementNS(SVG_NS, tag);
  copyAttributes(element, out, prefix);
  for (const child of Array.from(element.childNodes)) {
    sanitizeInto(child, out, prefix, depth + 1, budget);
  }
  target.appendChild(out);
}

export interface SanitizedSvgFigure {
  svg: string;
  title: string;
  width: number;
  height: number;
}

function directText(root: Element, tag: string): string {
  for (const child of Array.from(root.children)) {
    if (child.tagName.toLowerCase() === tag) return (child.textContent ?? '').trim();
  }
  return '';
}

/** Sanitize a model-authored SVG. Returns null for anything that is not a
 *  parseable <svg> element. */
export function sanitizeSvg(raw: string): SanitizedSvgFigure | null {
  if (!raw.trim() || raw.length > MAX_SVG_CHARS) return null;
  const doc = new DOMParser().parseFromString(raw, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'svg') return null;
  if (doc.getElementsByTagName('parsererror').length > 0) return null;

  const title = directText(root, 'title');
  const prefix = `fig${hash(raw)}_`;
  const out = document.createElementNS(SVG_NS, 'svg');
  copyAttributes(root, out, prefix);
  out.setAttribute('xmlns', SVG_NS);
  out.setAttribute('role', 'img');
  out.setAttribute('class', 'markdown-svg');
  out.setAttribute('focusable', 'false');
  out.setAttribute('aria-label', title || 'Diagram');
  out.removeAttribute('width');
  out.removeAttribute('height');
  if (!out.getAttribute('viewBox')) {
    const width = Number(root.getAttribute('width'));
    const height = Number(root.getAttribute('height'));
    out.setAttribute(
      'viewBox',
      Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
        ? `0 0 ${width} ${height}`
        : '0 0 800 600',
    );
  }
  const budget: SanitizeBudget = { nodes: MAX_SVG_NODES };
  for (const child of Array.from(root.childNodes)) {
    sanitizeInto(child, out, prefix, 0, budget);
  }

  const viewBox = (out.getAttribute('viewBox') ?? '0 0 800 600').split(/[\s,]+/).map(Number);
  const width = Number.isFinite(viewBox[2]) && viewBox[2] > 0 ? viewBox[2] : 800;
  const height = Number.isFinite(viewBox[3]) && viewBox[3] > 0 ? viewBox[3] : 600;
  return {
    svg: new XMLSerializer().serializeToString(out),
    title,
    width,
    height,
  };
}

const MORE_ICON_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/></svg>';

const DOWNLOAD_ICON_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';

/** Render the sanitized SVG inside the figure shell. Returns null when the
 *  block does not parse, so the caller can fall back to a code block. */
export function renderSvgFigure(raw: string, caption: string): string | null {
  const figure = sanitizeSvg(raw);
  if (!figure) return null;
  const title = caption.trim() || figure.title || 'SVG diagram';
  return (
    `<figure class="markdown-figure" data-svg-figure data-svg-title="${escapeAttr(title)}">` +
      `<div class="markdown-figure-head">` +
        `<span class="markdown-figure-kicker">SVG · diagram</span>` +
        `<details class="markdown-figure-menu">` +
          `<summary aria-label="Figure actions" title="Figure actions">${MORE_ICON_SVG}</summary>` +
          `<div class="markdown-figure-menu-body" role="menu">` +
            `<a href="#" role="menuitem" data-svg-action="copy">${COPY_ICON_SVG}<span>Copy as image</span><kbd>PNG</kbd></a>` +
            `<a href="#" role="menuitem" data-svg-action="svg">${DOWNLOAD_ICON_SVG}<span>Download as SVG</span><kbd>.svg</kbd></a>` +
            `<a href="#" role="menuitem" data-svg-action="png">${DOWNLOAD_ICON_SVG}<span>Download as PNG</span><kbd>2×</kbd></a>` +
          `</div>` +
        `</details>` +
      `</div>` +
      `<div class="markdown-figure-frame">${figure.svg}</div>` +
      `<figcaption><strong>${escapeHtml(title)}</strong><span class="markdown-figure-type">SVG</span></figcaption>` +
    `</figure>`
  );
}

const EXPORT_STYLE_PROPS = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-opacity', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'opacity', 'font-family', 'font-size', 'font-weight', 'font-style',
  'letter-spacing', 'text-anchor', 'dominant-baseline', 'alignment-baseline',
];

function themeBackground(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--dt-card').trim();
  return value || 'rgb(23 23 23)';
}

export interface ExportedSvgFigure {
  text: string;
  width: number;
  height: number;
}

/** Serialize the ON-SCREEN svg with its resolved colors and a theme
 *  background. Presentation attributes that still contain var() are removed
 *  because the inline style carries the computed value. */
export function serializeFigureSvg(svg: SVGSVGElement): ExportedSvgFigure {
  const viewBox = svg.viewBox.baseVal;
  const width = Math.max(1, Math.round(viewBox?.width || svg.getBoundingClientRect().width || 800));
  const height = Math.max(1, Math.round(viewBox?.height || svg.getBoundingClientRect().height || 600));
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const originals = [svg, ...Array.from(svg.querySelectorAll('*'))];
  const copies = [clone, ...Array.from(clone.querySelectorAll('*'))];
  originals.forEach((source, index) => {
    const computed = getComputedStyle(source);
    for (const prop of EXPORT_STYLE_PROPS) {
      const value = computed.getPropertyValue(prop);
      if (value) (copies[index] as SVGElement).style.setProperty(prop, value);
    }
  });
  copies.forEach((element) => {
    for (const attr of Array.from(element.attributes)) {
      if (attr.value.includes('var(')) element.removeAttribute(attr.name);
    }
  });
  clone.setAttribute('xmlns', SVG_NS);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  const background = document.createElementNS(SVG_NS, 'rect');
  background.setAttribute('x', '0');
  background.setAttribute('y', '0');
  background.setAttribute('width', String(width));
  background.setAttribute('height', String(height));
  background.setAttribute('rx', '12');
  background.setAttribute('fill', themeBackground());
  const anchor = clone.querySelector('desc') || clone.querySelector('title');
  if (anchor) anchor.after(background);
  else clone.insertBefore(background, clone.firstChild);
  return {
    text: new XMLSerializer().serializeToString(clone),
    width,
    height,
  };
}

export function figureFilename(title: string, extension: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${slug || 'august-diagram'}.${extension}`;
}

export function downloadFigureSvg(svg: SVGSVGElement, title: string): void {
  const { text } = serializeFigureSvg(svg);
  downloadBlob(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }), figureFilename(title, 'svg'));
}

export function svgToPngBlob(svg: SVGSVGElement, scale = 2): Promise<Blob> {
  const { text, width, height } = serializeFigureSvg(svg);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('Canvas unavailable'));
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('PNG encode failed'));
      }, 'image/png');
    };
    image.onerror = () => reject(new Error('Could not render the diagram'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  });
}

export function downloadFigurePng(svg: SVGSVGElement, title: string): Promise<void> {
  return svgToPngBlob(svg).then((blob) => {
    downloadBlob(blob, figureFilename(title, 'png'));
  });
}

export async function copyFigurePng(svg: SVGSVGElement): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('Clipboard unavailable');
  }
  const blob = await svgToPngBlob(svg);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}
