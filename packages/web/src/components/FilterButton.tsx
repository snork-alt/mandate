import { useState, type ReactNode } from 'react';
import { SearchField } from './SearchField';
import { Button, Checkbox, Popover, ScrollArea, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconX } from '@tabler/icons-react';

export interface FilterOption {
  value: string;
  label: string;
  icon?: ReactNode;
  count?: number;
  /** Section heading: consecutive options with the same group are listed under it, groups split by a divider. */
  group?: string;
}

interface Props {
  label: string;
  options: FilterOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  /** Search box in the menu when there are more than 8 options. */
  searchable?: boolean;
  /** Small clear x on the button while a selection is active. */
  clearable?: boolean;
  /** `colon` reads "Agent: first +1" (default `inline`: "Agent first" / "2 selected"). */
  summary?: 'inline' | 'colon';
  /** Max list height before it scrolls (default 300). */
  maxHeight?: number;
  /** Dropdown width (default 220). */
  width?: number;
}

/** Compact toolbar button opening a checkbox list; shows the active selection inline. */
export function FilterButton({ label, options, selected, onChange, searchable, clearable, summary: summaryStyle = 'inline', maxHeight = 300, width = 220 }: Props) {
  const [query, setQuery] = useState('');
  const active = selected.length > 0;
  const firstLabel = options.find((o) => o.value === selected[0])?.label ?? selected[0];
  const summary = summaryStyle === 'colon' ? `${firstLabel}${selected.length > 1 ? ` +${selected.length - 1}` : ''}` : selected.length === 1 ? firstLabel : `${selected.length} selected`;
  const shown = searchable && options.length > 8 && query ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase())) : options;
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  return (
    <Popover position="bottom-start" shadow="md" radius="md" width={width} withinPortal onClose={() => setQuery('')}>
      <Popover.Target>
        <Button
          variant={active ? 'light' : 'default'}
          color={active ? undefined : 'gray'}
          rightSection={<IconChevronDown size={12} />}
          className="filter-button"
        >
          {label}
          {summaryStyle === 'colon' && active ? ':' : ''}
          {active && (
            <Text span size="sm" fw={500} ml={6} c="var(--mantine-color-text)" className="filter-summary">
              {summary}
            </Text>
          )}
          {active && clearable && (
            <span
              role="button"
              aria-label={`Clear ${label} filter`}
              className="filter-x"
              onClick={(e) => {
                e.stopPropagation();
                onChange([]);
              }}
            >
              <IconX size={11} />
            </span>
          )}
        </Button>
      </Popover.Target>
      <Popover.Dropdown p={6}>
        {searchable && options.length > 8 && (
          <SearchField variant="input" size="sm" autoFocus value={query} onChange={setQuery} placeholder={`Search ${label.toLowerCase()}…`} ariaLabel={`Search ${label}`} style={{ marginBottom: 6 }} />
        )}
        <ScrollArea.Autosize mah={maxHeight}>
          <Stack gap={1}>
            {options.length === 0 && (
              <Text size="sm" c="var(--app-text-faint)" p={6}>
                Nothing to filter
              </Text>
            )}
            {shown.map((o, i) => [
              o.group && o.group !== shown[i - 1]?.group && (
                <div key={`g-${o.group}`} className="filter-group" data-first={i === 0 || undefined} role="presentation">
                  {o.group}
                </div>
              ),
              <UnstyledButton key={o.value} className="filter-option" onClick={() => toggle(o.value)}>
                <Checkbox checked={selected.includes(o.value)} readOnly size="xs" tabIndex={-1} styles={{ input: { cursor: 'pointer' } }} />
                {o.icon}
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.label}</span>
                {o.count !== undefined && <span className="filter-count">{o.count}</span>}
              </UnstyledButton>,
            ])}
          </Stack>
        </ScrollArea.Autosize>
        {active && (
          <UnstyledButton className="filter-clear" onClick={() => onChange([])}>
            Clear
          </UnstyledButton>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}
