import { useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { Group, Kbd, Loader } from '@mantine/core';
import { IconSearch, IconX } from '@tabler/icons-react';

/**
 * The app's one search box: the sidebar trigger (`button`), the Cmd+K input and the Ask question box (`input`)
 * share this markup and the `.search-field` styles, so they cannot drift apart.
 */
interface Base {
  className?: string;
  style?: CSSProperties;
  /** `sm` for popovers and pickers, `md` default, `lg` for Cmd+K. */
  size?: 'sm' | 'md' | 'lg';
}
export interface SearchFieldButtonProps extends Base {
  variant: 'button';
  label: string;
  /** Shortcut badges, e.g. ['⌘', 'K']. */
  keys?: string[];
  onClick: () => void;
}
export interface SearchFieldInputProps extends Base {
  variant: 'input';
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  /** Textarea that grows with its content up to `maxRows`. */
  multiline?: boolean;
  maxRows?: number;
  inputRef?: Ref<HTMLInputElement | HTMLTextAreaElement>;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  /** Right end of the field (shortcut badges, send button, spinner). */
  right?: ReactNode;
  /** Replace the leading search icon. */
  icon?: ReactNode;
  /** Show a clear (×) button while there is text; Esc clears first. Default: true for single-line fields. */
  clearable?: boolean;
  /** Spinner at the right end (e.g. while results load). */
  loading?: boolean;
  autoFocus?: boolean;
}
export type SearchFieldProps = SearchFieldButtonProps | SearchFieldInputProps;

export const ICON = <IconSearch size={14} />;
const LINE = 20;

export function SearchField(props: SearchFieldProps) {
  const cls = ['search-field', props.className].filter(Boolean).join(' ');
  if (props.variant === 'button') {
    return (
      <button type="button" className={`search-trigger ${cls}`} style={props.style} onClick={props.onClick}>
        {ICON}
        <span>{props.label}</span>
        {props.keys && (
          <Group gap={2} ml="auto">
            {props.keys.map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
          </Group>
        )}
      </button>
    );
  }
  return <InputField {...props} cls={cls} />;
}

function InputField({ cls, ...p }: SearchFieldInputProps & { cls: string }) {
  const clearable = p.clearable ?? !p.multiline;
  const ta = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!p.multiline || !el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, LINE * (p.maxRows ?? 6))}px`;
  });  // every render: the pane may have been hidden (scrollHeight 0) when the value last changed
  const common = {
    className: 'search-field-input',
    value: p.value,
    placeholder: p.placeholder,
    disabled: p.disabled,
    'aria-label': p.ariaLabel,
    spellCheck: false,
    autoComplete: 'off',
    autoFocus: p.autoFocus,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      // Esc clears the text first; a second Esc reaches the caller (e.g. to close a popover).
      if (e.key === 'Escape' && clearable && p.value) {
        e.preventDefault();
        e.stopPropagation();
        p.onChange('');
        return;
      }
      p.onKeyDown?.(e);
    },
  } as const;
  const clear = clearable && p.value && !p.disabled;
  return (
    <div className={`search-trigger search-field-input-wrap ${cls}`} data-size={p.size} data-multiline={p.multiline || undefined} data-disabled={p.disabled || undefined} style={p.style}>
      {p.icon ?? ICON}
      {p.multiline ? (
        <textarea
          {...common}
          rows={1}
          ref={(el) => {
            ta.current = el;
            if (typeof p.inputRef === 'function') p.inputRef(el);
            else if (p.inputRef) (p.inputRef as { current: unknown }).current = el;
          }}
          onChange={(e) => p.onChange(e.currentTarget.value)}
        />
      ) : (
        <input {...common} ref={p.inputRef as Ref<HTMLInputElement>} onChange={(e) => p.onChange(e.currentTarget.value)} />
      )}
      {p.loading && <Loader size={12} className="search-field-loader" />}
      {clear && (
        <button
          type="button"
          className="search-field-clear"
          aria-label="Clear search"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => p.onChange('')}
        >
          <IconX size={12} stroke={2} />
        </button>
      )}
      {p.right}
    </div>
  );
}
