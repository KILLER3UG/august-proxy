/* Typed client for the Nessa Docs catalog door (`/api/docs-state`).

The backend owns every rule — see `app/services/docs_state.py`. This module only
mirrors the wire shape, so a field renamed on one side shows up here as a type
error rather than as a panel that quietly renders nothing. */

import { api } from '../client';

export interface DocsPageNode {
  id: string;
  title: string;
  kind: string;
  status: string;
  summary: string;
  parent: string | null;
  path: string;
  sources: string[];
  diagramLinks: Record<string, string>;
  diagramDetails: Record<string, string>;
  sourceRevision: string | null;
  diagrams: number;
}

export interface DocsIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path: string;
}

export interface DocsCatalog {
  projectRoot: string;
  stateDir: string;
  found: boolean;
  pages: DocsPageNode[];
  bodies: Record<string, string>;
  roots: string[];
  health: {
    errors: number;
    warnings: number;
    issues: DocsIssue[];
  };
}

export interface DocsPageResponse {
  found: boolean;
  page: DocsPageNode | null;
  body: string;
  denial?: string;
}

const enc = encodeURIComponent;

export function fetchDocsCatalog(project: string): Promise<DocsCatalog> {
  return api.get<DocsCatalog>(`/api/docs-state?project=${enc(project)}`);
}

export function fetchDocsPage(project: string, id: string): Promise<DocsPageResponse> {
  return api.get<DocsPageResponse>(
    `/api/docs-state/page?project=${enc(project)}&id=${enc(id)}`,
  );
}
