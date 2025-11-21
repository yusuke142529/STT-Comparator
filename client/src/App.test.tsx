import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import App from './App';

describe('App shell', () => {
  it('renders heading', () => {
    const output = renderToString(<App />);
    expect(output).toContain('STT Comparator');
  });
});
