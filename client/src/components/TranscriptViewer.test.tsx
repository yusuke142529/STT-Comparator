import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TranscriptViewer } from './TranscriptViewer';
import type { TranscriptRow } from '../types/app';

const baseRow = (overrides: Partial<TranscriptRow> = {}): TranscriptRow => ({
  id: '1',
  text: 'hello',
  provider: 'mock',
  channel: 'mic',
  isFinal: true,
  timestamp: Date.now(),
  ...overrides,
});

describe('TranscriptViewer', () => {
  it('shows degraded badge when transcript is marked degraded', () => {
    const rows = [baseRow({ degraded: true })];
    render(
      <TranscriptViewer
        transcripts={rows}
        containerRef={{ current: null }}
        showJumpButton={false}
        onJumpToBottom={() => {}}
      />
    );

    expect(screen.getByText(/degraded/i)).toBeInTheDocument();
  });
});
