import { notifications } from '@mantine/notifications';
import { createElement } from 'react';

/** Copy text and confirm with a toast showing what was copied (monospace, truncated). */
export async function copyText(text: string, title = 'Copied reference'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for non-secure contexts.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const preview = text.length > 280 ? `${text.slice(0, 280)}…` : text;
  notifications.show({
    title,
    message: createElement('code', { className: 'toast-code' }, preview),
    autoClose: 2200,
    withBorder: true,
  });
}
