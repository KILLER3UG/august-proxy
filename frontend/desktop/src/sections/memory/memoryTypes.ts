import {
  Brain, Database, Search,
  Shield, Network, Tag, Box,
} from 'lucide-react';

export const TABS = [
  { key: 'overview', label: 'Overview', icon: Brain },
  { key: 'vectors', label: 'Vectors', icon: Database },
  { key: 'facts', label: 'Facts', icon: Tag },
  { key: 'guidelines', label: 'Guidelines', icon: Shield },
  { key: 'graph', label: 'Graph', icon: Network },
  { key: 'search', label: 'Search', icon: Search },
  { key: 'prompt', label: 'Prompt', icon: Box },
] as const;

export type Tab = typeof TABS[number]['key'];

export interface VectorEntry {
  id: string;
  topic: string;
  summary: string;
  timestamp?: string;
  tags?: string[];
}

export interface MemoryItem {
  id?: string;
  type: string;
  key: string;
  title?: string;
  summary: string;
  status?: string;
  pinned?: boolean;
  confidence?: number;
  source?: string;
  updatedAt?: string;
  injection?: { score: number; reason: string };
}

export interface Guideline {
  id: string;
  text: string;
  source: string;
  confidence?: number;
  status: string;
  count?: number;
  createdAt: string;
  lastSeenAt?: string;
  lastUsedAt?: string;
}

export interface StoreStatus {
  count?: number;
  driver?: string;
  path?: string;
  available?: boolean;
}

export interface GraphStats {
  stats?: {
    counts?: { entities?: number; relations?: number; observations?: number };
    entityTypes?: Record<string, number>;
    updatedAt?: string;
  };
}

export interface SearchResult {
  provider: string;
  type: string;
  title: string;
  text: string;
  score: number;
  key?: string;
  quality?: { score: number; confidence: number; label: string };
}

export interface BrainDiagnostics {
  error?: string;
  injectedChars?: number;
  maxChars?: number;
  compacted?: boolean;
  guidelines?: number;
  semanticFacts?: number;
  vectorEntries?: number;
}

export interface LearningStatus {
  status: string;
  lastStartedAt?: string;
  lastTopic?: string;
}
