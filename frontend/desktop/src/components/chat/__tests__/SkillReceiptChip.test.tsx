import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SkillReceiptChip } from '../SkillReceiptChip';
import type { ChatMessage } from '@/types/chat';

type Tool = NonNullable<ChatMessage['tools']>[number];

function tool(name: string, args?: Record<string, unknown>): Tool {
  return {
    id: `${name}-1`,
    name,
    status: 'done',
    context: args ? JSON.stringify(args) : undefined,
  };
}

describe('SkillReceiptChip', () => {
  it('renders nothing when the turn touched no skill file', () => {
    const { container } = render(
      <SkillReceiptChip tools={[tool('read_file', { filePath: '/tmp/a.ts' })]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for a write that is not a skill', () => {
    const { container } = render(
      <SkillReceiptChip tools={[tool('write_file', { filePath: '/tmp/notes.md' })]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when a READ touches a skill file (a read is not a write)', () => {
    const { container } = render(
      <SkillReceiptChip
        tools={[tool('read_file', { filePath: '/home/u/.august/skills/tutor/SKILL.md' })]}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('names the skill when the turn wrote its SKILL.md', () => {
    render(
      <SkillReceiptChip
        tools={[tool('write_file', { filePath: '/home/u/.august/skills/tutor/SKILL.md' })]}
      />,
    );
    expect(screen.getByTestId('skill-receipt-chip')).toHaveTextContent('Skill updated: tutor');
  });

  it('counts multiple skills', () => {
    render(
      <SkillReceiptChip
        tools={[
          tool('write_file', { file_path: 'skills/alpha/SKILL.md' }),
          tool('edit_lines', { path: 'C:\\\\proj\\\\.aug\\\\skills\\\\beta\\\\SKILL.md' }),
        ]}
      />,
    );
    expect(screen.getByTestId('skill-receipt-chip')).toHaveTextContent('2 skills updated');
  });

  it('tolerates unparseable args', () => {
    const { container } = render(<SkillReceiptChip tools={[tool('write_file')]} />);
    expect(container.firstChild).toBeNull();
  });
});