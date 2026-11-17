// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it } from 'vitest';
import { installDom } from './dom';
import { TldrCard } from '../src/components/doc';
import { TrackedFieldsContext } from '../src/components/doc/tracked/context';

installDom();
afterEach(cleanup);
const R = ({ children }: { children: React.ReactNode }) => (
  <MantineProvider>
    <MemoryRouter>{children}</MemoryRouter>
  </MantineProvider>
);

describe('TldrCard', () => {
  it('shows a labelled card with the markdown rendered', () => {
    const { container } = render(<R><TldrCard tldr={'Lets people sign in once.\n\n- Works across apps\n- Ends after a day'} /></R>);
    expect(screen.getByLabelText('TL;DR').textContent).toContain('TL;DR');
    expect(container.querySelectorAll('.doc-tldr li')).toHaveLength(2);
    expect(screen.getByText('Lets people sign in once.')).toBeTruthy();
  });
  it('renders nothing without a tldr', () => {
    const { container } = render(<R><TldrCard tldr={undefined} /></R>);
    expect(container.querySelector('.doc-tldr')).toBeNull();
  });
  it('marks a changed tldr (old struck through, new inserted) when tracking a version', () => {
    const changes = new Map([['tldr', { before: 'Old words.', after: 'New words.' }]]);
    const { container } = render(
      <R>
        <TrackedFieldsContext.Provider value={changes as never}>
          <TldrCard tldr="New words." />
        </TrackedFieldsContext.Provider>
      </R>,
    );
    expect(container.querySelector('del')?.textContent).toContain('Old words.');
    expect(container.querySelector('ins')?.textContent).toContain('New words.');
  });
});
