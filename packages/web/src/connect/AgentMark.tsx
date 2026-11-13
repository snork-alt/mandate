import { useId } from 'react';
import { AgentIcon } from '../setup/flowApi';

const ray = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return `M8 8L${(8 + Math.cos(a) * 5.2).toFixed(2)} ${(8 + Math.sin(a) * 5.2).toFixed(2)}`;
  }).join('');
const CLAUDE_RAYS = ray(10);

/** Simple brand-like marks of the main coding agents (16×16); other agents fall back to the app's Tabler agent icons. */
export function AgentMark({ agent, size = 16 }: { agent: string; size?: number }) {
  const gid = useId();
  let svg: React.ReactNode = null;
  switch (agent) {
    case 'claude-code':
      svg = (
        <>
          <rect width="16" height="16" fill="#D97757" />
          <path d={CLAUDE_RAYS} stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
        </>
      );
      break;
    case 'codex':
      svg = (
        <>
          <rect width="16" height="16" fill="#111" />
          <path d="M4.2 5.4 6.8 8l-2.6 2.6M8.4 11h3.6" stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
      break;
    case 'cursor':
      svg = (
        <>
          <rect width="16" height="16" fill="#151515" />
          <path d="M8 2.8 12.6 5.4v5.2L8 13.2 3.4 10.6V5.4Z" fill="none" stroke="#fff" strokeWidth="1.1" strokeLinejoin="round" />
          <path d="M3.4 5.4 8 8l4.6-2.6M8 8v5.2" stroke="#fff" strokeWidth="1.1" fill="none" />
          <path d="M8 2.8 12.6 5.4 8 8Z" fill="#fff" opacity=".85" />
        </>
      );
      break;
    case 'vscode':
      svg = (
        <>
          <rect width="16" height="16" fill="#1883d7" />
          <path d="M11.2 2.6 13.4 3.7v8.6l-2.2 1.1L6.1 8.9 3.9 10.6l-1.1-.6V6l1.1-.6 2.2 1.7Zm0 3L8.2 8l3 2.4Z" fill="#fff" />
        </>
      );
      break;
    case 'gemini':
      svg = (
        <>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#4f8df5" />
              <stop offset=".6" stopColor="#8b6cf0" />
              <stop offset="1" stopColor="#d96f9a" />
            </linearGradient>
          </defs>
          <rect width="16" height="16" fill="#fff" />
          <path d="M8 1.8C8.6 5.2 10.8 7.4 14.2 8 10.8 8.6 8.6 10.8 8 14.2 7.4 10.8 5.2 8.6 1.8 8 5.2 7.4 7.4 5.2 8 1.8Z" fill={`url(#${gid})`} />
        </>
      );
      break;
    case 'windsurf':
      svg = (
        <>
          <rect width="16" height="16" fill="#0c1513" />
          <path d="M2.8 10.6c1.9 0 2.2-4.9 4.6-4.9s1.6 4.9 3.6 4.9 1.6-2.4 2.2-2.4" stroke="#3ce0b4" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </>
      );
      break;
    case 'opencode':
      svg = (
        <>
          <rect width="16" height="16" fill="#fff" />
          <rect x="3.3" y="2.8" width="9.4" height="10.4" fill="none" stroke="#111" strokeWidth="1.5" />
          <rect x="5.6" y="7.4" width="4.8" height="3.6" fill="#111" opacity=".85" />
        </>
      );
      break;
  }
  if (!svg) return <AgentIcon client={agent} size={size} />;
  return (
    <span className="agent-mark" data-light={agent === 'gemini' || agent === 'opencode' || undefined} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 16 16" width={size} height={size}>
        {svg}
      </svg>
    </span>
  );
}
