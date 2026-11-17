// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { PlanStep } from '@mandate/shared';
import { installDom } from './dom';
import { PlanSteps } from '../src/components/work-orders/PlanSteps';

installDom();
afterEach(cleanup);
const at = new Date().toISOString();
const step = (id: string, text: string, status: PlanStep['status'], x: Partial<PlanStep> = {}): PlanStep => ({ id, text, status, updatedAt: at, by: 'agent@x', ...x });

describe('PlanSteps', () => {
  it('renders the live checklist: status, note, chips, code refs, who; the in-progress step is current', () => {
    render(
      <MantineProvider>
        <MemoryRouter>
          <PlanSteps
            spec="auth"
            steps={[
              step('s1', 'Add the route', 'done', { sections: ['login'], codeRefs: [{ repo: 'app', path: 'src/route.ts' } as never] }),
              step('s2', 'Write the test', 'in_progress', { proves: ['ac-login'] }),
              step('s3', 'Docs', 'skipped', { note: 'no docs for this' }),
              step('s4', 'Ship', 'pending'),
            ]}
          />
        </MemoryRouter>
      </MantineProvider>,
    );
    const list = screen.getByTestId('wo-steps');
    expect(within(list).getByText('2/4', { exact: false })).toBeTruthy();
    const items = list.querySelectorAll('li');
    expect([...items].map((i) => i.getAttribute('data-status'))).toEqual(['done', 'in_progress', 'skipped', 'pending']);
    expect(items[1]!.getAttribute('aria-current')).toBe('step');
    expect(items[3]!.getAttribute('aria-current')).toBeNull();
    expect(within(list).getByText('no docs for this')).toBeTruthy();
    expect(within(list).getByText('login').getAttribute('href')).toBe('/specs/auth#section-login');
    expect(within(list).getByText('proves ac-login')).toBeTruthy();
    expect(within(list).getByText('app:src/route.ts')).toBeTruthy();
    expect(within(items[0]!).getByText('agent@x', { exact: false })).toBeTruthy();
  });

  it('renders nothing without steps', () => {
    const { container } = render(<PlanSteps steps={[]} spec="x" />);
    expect(container.innerHTML).toBe('');
  });
});
