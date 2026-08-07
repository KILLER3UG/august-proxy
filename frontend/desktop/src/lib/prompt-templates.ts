/* ── Prompt templates — localStorage-backed template library ─────── */
/* Users save reusable prompt templates with optional variables.      */

export interface PromptTemplate {
  id: string;
  name: string;
  content: string;
  /** Variable placeholders like {{name}}, {{code}}. */
  variables: string[];
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = 'august_prompt_templates';

function loadTemplates(): PromptTemplate[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveTemplates(templates: PromptTemplate[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
}

/** Extract variable names from template content ({{varName}}). */
export function extractVariables(content: string): string[] {
  const matches = content.match(/\{\{(\w+)\}\}/g);
  if (!matches) return [];
  return [...new Set(matches.map(m => m.slice(2, -2)))];
}

/** List all saved templates. */
export function listTemplates(): PromptTemplate[] {
  return loadTemplates().sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Get a template by id. */
export function getTemplate(id: string): PromptTemplate | undefined {
  return loadTemplates().find(t => t.id === id);
}

/** Create a new template. */
export function createTemplate(name: string, content: string): PromptTemplate {
  const templates = loadTemplates();
  const template: PromptTemplate = {
    id: `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim(),
    content,
    variables: extractVariables(content),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  templates.push(template);
  saveTemplates(templates);
  return template;
}

/** Update an existing template. */
export function updateTemplate(id: string, updates: Partial<Pick<PromptTemplate, 'name' | 'content'>>): PromptTemplate | undefined {
  const templates = loadTemplates();
  const idx = templates.findIndex(t => t.id === id);
  if (idx === -1) return undefined;
  const template = templates[idx];
  if (updates.name !== undefined) template.name = updates.name.trim();
  if (updates.content !== undefined) {
    template.content = updates.content;
    template.variables = extractVariables(updates.content);
  }
  template.updatedAt = Date.now();
  saveTemplates(templates);
  return template;
}

/** Delete a template. */
export function deleteTemplate(id: string): boolean {
  const templates = loadTemplates();
  const idx = templates.findIndex(t => t.id === id);
  if (idx === -1) return false;
  templates.splice(idx, 1);
  saveTemplates(templates);
  return true;
}

/** Fill variables in a template content string. */
export function fillTemplate(content: string, vars: Record<string, string>): string {
  let result = content;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}
