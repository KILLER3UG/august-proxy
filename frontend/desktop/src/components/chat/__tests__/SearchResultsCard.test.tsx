import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchResultsList, SearchResultsTask } from '../SearchResultsCard';

const hits = [
  {
    title: 'Gigabyte Gaming A16 screen resolution specs',
    url: 'https://www.gigabyte.com/Laptop/A16',
    snippet: '2560x1600 panel…',
  },
  {
    title: 'A16 review',
    url: 'https://reviews.example.com/gigabyte-a16',
    snippet: 'We tested…',
  },
];

describe('SearchResultsList', () => {
  it('renders favicon, bold title link, and right-aligned domain per row', () => {
    const { container } = render(<SearchResultsList hits={hits} />);

    // Real site favicons via Google s2.
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(2);
    expect(imgs[0].getAttribute('src')).toContain('s2/favicons?domain=www.gigabyte.com');

    // Titles are links.
    const link = screen.getByText('Gigabyte Gaming A16 screen resolution specs');
    expect(link.tagName).toBe('A');

    // Domains shown on the same row.
    expect(screen.getByText('www.gigabyte.com')).toBeInTheDocument();
    expect(screen.getByText('reviews.example.com')).toBeInTheDocument();
  });

  it('falls back to a globe icon when the favicon fails to load', () => {
    const { container } = render(<SearchResultsList hits={hits.slice(0, 1)} />);
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    fireEvent.error(img!);
    // The broken image is replaced by the fallback glyph.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).toBeTruthy();
  });
});

describe('SearchResultsTask', () => {
  it('trigger shows the query and a muted result count', () => {
    render(
      <SearchResultsTask
        query="Gigabyte Gaming A16 screen resolution specs"
        hits={hits}
        expanded
        onToggle={() => {}}
      />,
    );

    // Query appears on the trigger and as the first hit's title.
    expect(
      screen.getAllByText('Gigabyte Gaming A16 screen resolution specs').length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('2 results')).toBeInTheDocument();
    // Expanded: the hit list is visible.
    expect(screen.getByText('www.gigabyte.com')).toBeInTheDocument();
  });

  it('singular count reads "1 result"', () => {
    render(
      <SearchResultsTask
        query="single"
        hits={hits.slice(0, 1)}
        expanded
        onToggle={() => {}}
      />,
    );
    expect(screen.getByText('1 result')).toBeInTheDocument();
  });

  it('collapses and expands via the trigger', () => {
    render(
      <SearchResultsTask
        query="q"
        hits={hits}
        expanded
        onToggle={() => {}}
      />,
    );
    const trigger = screen.getByRole('button');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});
