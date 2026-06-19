import { describe, it, expect } from 'vitest';
import { SERVICE_LINKS } from './service-links';

describe('SERVICE_LINKS', () => {
  it('exposes the three expected service groups', () => {
    expect(Object.keys(SERVICE_LINKS).sort()).toEqual(['github', 'google', 'slack']);
  });

  it('every URL is a non-empty https:// URL', () => {
    const flat: Array<[string, string]> = [];
    for (const [service, group] of Object.entries(SERVICE_LINKS)) {
      for (const [key, url] of Object.entries(group)) {
        flat.push([`${service}.${key}`, url]);
      }
    }
    expect(flat.length).toBeGreaterThan(0);
    for (const [name, url] of flat) {
      expect(url, `${name} should be defined`).toBeTruthy();
      expect(typeof url).toBe('string');
      expect(url.startsWith('https://'), `${name} should use https:// (got ${url})`).toBe(true);
    }
  });

  it('Google has separate clientIdAndSecret and redirectUriDocs entries', () => {
    expect(SERVICE_LINKS.google.clientIdAndSecret).toContain('console.cloud.google.com');
    expect(SERVICE_LINKS.google.redirectUriDocs).toContain('support.google.com');
  });

  it('GitHub token link targets the fine-grained PAT page', () => {
    expect(SERVICE_LINKS.github.token).toContain('github.com/settings/tokens');
  });

  it('Slack has distinct botToken and teamId entries', () => {
    expect(SERVICE_LINKS.slack.botToken).toContain('api.slack.com');
    expect(SERVICE_LINKS.slack.teamId).toContain('slack.com');
  });
});
