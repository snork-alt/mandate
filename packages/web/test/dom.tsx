import type { ReactNode } from 'react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/** jsdom lacks matchMedia / ResizeObserver, which Mantine and the canvas viewer use. */
export function installDom() {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.scrollIntoView ??= () => undefined;
}

export function Wrap({ children, client }: { children: ReactNode; client?: QueryClient }) {
  return (
    <MantineProvider>
      <QueryClientProvider client={client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
    </MantineProvider>
  );
}
