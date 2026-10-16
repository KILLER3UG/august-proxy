/** The attachment card must hug the media's own aspect ratio.
 *
 *  It used to be a fixed `aspect-[3/4]` frame with `object-cover`. PDF pages
 *  are rasterised at their native MediaBox size (`renderPdfThumbnail`,
 *  lib/file-reader.ts:149-151), so a landscape page arrived ~160x113 and was
 *  scaled to cover a 148x197 portrait box — roughly 47% of the page width lost
 *  on each side, which is how the reference's own use case (a wide flowchart
 *  PDF) rendered as an unreadable centre strip.
 *
 *  The landscape case is the one that was broken; the portrait case is the
 *  control that proves the card is not simply always-wide now.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FileAttachmentCard } from '../FileAttachmentCard';
import type { FileAttachment } from '@/types/chat';

function attachment(width: number, height: number): FileAttachment {
  return {
    id: 'att-1',
    name: 'diagram.pdf',
    size: '1 KB',
    type: 'text',
    status: 'ready',
    thumbnailUrl: 'data:image/jpeg;base64,xxxxxxxx',
    mimeType: `image/x-test; w=${width}; h=${height}`,
  } as unknown as FileAttachment;
}

/** CSS accepts a unitless `aspect-ratio`, which is the form the card writes. */
function readRatio(raw: string): number {
  const parts = raw.split('/');
  return parts.length > 1 ? Number(parts[0]) / Number(parts[1]) : Number(raw);
}

/** Render, then report the frame before and after the image reports its size. */
function mount(width: number, height: number) {
  const { container } = render(<FileAttachmentCard file={attachment(width, height)} />);
  const img = container.querySelector('img');
  expect(img, 'the card rendered without a thumbnail <img>').not.toBeNull();

  const frame = img!.parentElement as HTMLElement;
  const before = { ratio: frame.style.aspectRatio, fit: img!.className };

  // jsdom never decodes images, so naturalWidth/Height are reported by hand —
  // exactly the values a landscape vs portrait page produces on load.
  Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true });
  fireEvent.load(img!);

  return { before, ratio: readRatio(frame.style.aspectRatio), fit: img!.className };
}

describe('FileAttachmentCard aspect handling', () => {
  it('a landscape page widens the frame instead of being cropped to a strip', () => {
    const { before, ratio, fit } = mount(160, 113);
    expect(readRatio(before.ratio)).toBe(0.75);
    // Contained before load too, so the placeholder frame cannot crop.
    expect(fit).toContain('object-contain');
    expect(fit).not.toContain('object-cover');
    expect(ratio).toBeCloseTo(160 / 113, 3);
    expect(ratio).toBeGreaterThan(1);
  });

  it('control: a portrait page still gets a portrait frame', () => {
    const { ratio } = mount(160, 226);
    expect(ratio).toBeCloseTo(160 / 226, 3);
    expect(ratio).toBeLessThan(1);
  });

  it('an image that is already decoded still gets its ratio, with no load event', () => {
    // The branch this pins is the one a browser actually takes: a data-URL
    // thumbnail can finish decoding before React attaches `onLoad`, so the
    // event never fires and a load-only card stays portrait forever.
    const proto = window.HTMLImageElement.prototype;
    const stubs: Array<[string, PropertyDescriptor]> = [];
    for (const [key, value] of [
      ['complete', true],
      ['naturalWidth', 160],
      ['naturalHeight', 113],
    ] as const) {
      stubs.push([key, Object.getOwnPropertyDescriptor(proto, key) as PropertyDescriptor]);
      Object.defineProperty(proto, key, { value, configurable: true });
    }
    try {
      const { container } = render(<FileAttachmentCard file={attachment(160, 113)} />);
      const frame = container.querySelector('img')!.parentElement as HTMLElement;
      expect(readRatio(frame.style.aspectRatio)).toBeCloseTo(160 / 113, 3);
    } finally {
      for (const [key, desc] of stubs) {
        if (desc) Object.defineProperty(proto, key, desc);
        else Reflect.deleteProperty(proto, key);
      }
    }
  });

  it('the type badge survives the reflow', () => {
    render(<FileAttachmentCard file={attachment(160, 113)} />);
    expect(screen.getByText('PDF')).toBeTruthy();
  });
});
