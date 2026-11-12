/**
 * The one-line installer a Mandate server serves (`curl -fsSL <server>/p/<project>/install.sh | sh`, PowerShell:
 * `irm <server>/p/<project>/install.ps1 | iex`). It wires the developer's coding agents to this server by running the
 * CLI's `connect` at the server's EXACT version (`npx -y getmandate@<version>`: a compromised npm "latest" is never
 * pulled). The script holds no secret: only the server URL, the project id and the version. Agents sign in with GitHub
 * through MCP OAuth on first use; nothing secret is written.
 */
import { createHash } from 'node:crypto';

export interface InstallScriptInput {
  /** Origin agents reach (the public HTTPS URL, or http://localhost:<port> on this computer). */
  url: string;
  /** Project id, or null for the generic script (`--project` then required). */
  project: string | null;
  /** Exact getmandate version to run. */
  version: string;
}

const PROJECT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function check(i: InstallScriptInput): void {
  const u = new URL(i.url);
  if (u.origin !== i.url || !/^https?:$/.test(u.protocol)) throw new Error('installer: the URL must be a bare http(s) origin');
  if (i.project !== null && !PROJECT_RE.test(i.project)) throw new Error('installer: invalid project id');
  if (!VERSION_RE.test(i.version)) throw new Error('installer: invalid version');
}

/** POSIX sh installer (no secrets; `set -eu`; prints what it will do first). */
export function renderInstallSh(i: InstallScriptInput): string {
  check(i);
  return `#!/bin/sh
# Mandate installer: wires your coding agents to a Mandate server.
#   curl -fsSL ${i.url}${i.project ? `/p/${i.project}` : ''}/install.sh | sh
#   ... | sh -s -- --agents claude-code,codex --dry-run      (flags go to \`getmandate connect\`)
#   ... | sh -s -- --uninstall                              (removes the wiring again)
# This script contains no token or secret. Verify it first: ${i.url}${i.project ? `/p/${i.project}` : ''}/install.sh.sha256
set -eu

MANDATE_URL='${i.url}'
MANDATE_PROJECT='${i.project ?? ''}'
MANDATE_VERSION='${i.version}'

say() { printf '%s\\n' "$*"; }
die() { printf 'mandate: %s\\n' "$*" >&2; exit 1; }

UNINSTALL=0
YES=0
INSECURE=0
REPO_FLAG=''
for a in "$@"; do
  case "$a" in
    --uninstall) UNINSTALL=1 ;;
    --yes|-y) YES=1 ;;
    --insecure) INSECURE=1 ;;
    --repo) REPO_FLAG='--repo' ;;
    --no-repo) REPO_FLAG='--no-repo' ;;
  esac
done
case "$MANDATE_URL" in
  https://*) ;;
  http://localhost:*|http://127.0.0.1:*|http://localhost|http://127.0.0.1) ;;
  *) [ "$INSECURE" = 1 ] || die "refusing plain http ($MANDATE_URL): use the https URL, or pass --insecure" ;;
esac

if [ -z "$MANDATE_PROJECT" ]; then
  case " $* " in *" --project "*) ;; *) die "pass the project: sh -s -- --project <id> (or use $MANDATE_URL/p/<id>/install.sh)" ;; esac
fi

say "Mandate installer (getmandate $MANDATE_VERSION)"
say "  server:  $MANDATE_URL"
if [ -n "$MANDATE_PROJECT" ]; then say "  project: $MANDATE_PROJECT"; fi
if [ "$UNINSTALL" = 1 ]; then
  say "This will remove the Mandate MCP server entry from your coding agents (and this repo's wiring)."
else
  say "This will, for every coding agent found on this machine (Claude Code, Codex, Cursor, ...):"
  say "  - add the Mandate MCP server ($MANDATE_URL/p/<project>/mcp) to its user config;"
  say "  - add the Mandate skills and the /mandate-flow, /mandate-bootstrap commands;"
  say "  - sign-in: your agent opens GitHub sign-in on first use (MCP OAuth); no token is written."
  say "It runs: npx -y getmandate@$MANDATE_VERSION connect --url $MANDATE_URL ..."
fi
say ""

OS=$(uname -s 2>/dev/null || echo unknown)
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
fi
if [ "$NODE_MAJOR" -lt 22 ]; then
  say "Mandate needs Node.js 22 or newer (found: $(node --version 2>/dev/null || echo none)). Nothing was changed."
  if command -v volta >/dev/null 2>&1; then say "  volta install node@22"
  elif command -v fnm >/dev/null 2>&1; then say "  fnm install 22 && fnm use 22"
  elif [ -s "\${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then say "  nvm install 22 && nvm use 22"
  elif [ "$OS" = Darwin ]; then say "  brew install node   (or https://nodejs.org)"
  else say "  https://nodejs.org/en/download (or your package manager)"
  fi
  say "Then run this installer again."
  exit 1
fi
command -v npx >/dev/null 2>&1 || die "npx not found (it ships with Node.js / npm)"

# Inside a git repo: also wire this repo (project MCP entry, CLAUDE.md / AGENTS.md section)? Ask unless --yes.
if [ -z "$REPO_FLAG" ]; then
  if ROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
    if [ "$YES" = 1 ]; then REPO_FLAG='--repo'
    elif [ -r /dev/tty ]; then
      printf 'Also wire this repository (%s)? [Y/n] ' "$ROOT"
      read -r ans </dev/tty || ans=''
      case "$ans" in n|N|no|No) REPO_FLAG='--no-repo' ;; *) REPO_FLAG='--repo' ;; esac
    else REPO_FLAG='--no-repo'
    fi
  else REPO_FLAG='--no-repo'
  fi
fi

# Keep every other flag for \`getmandate connect\` (e.g. --agents a,b --dry-run --yes --project <id>).
n=$#
i=0
while [ "$i" -lt "$n" ]; do
  a=$1
  shift
  case "$a" in
    --uninstall|--insecure|--repo|--no-repo) ;;
    *) set -- "$@" "$a" ;;
  esac
  i=$((i + 1))
done
if [ "$UNINSTALL" = 1 ]; then set -- --remove "$@"; fi
set -- "$REPO_FLAG" "$@"
if [ -n "$MANDATE_PROJECT" ]; then set -- --project "$MANDATE_PROJECT" "$@"; fi
set -- connect --url "$MANDATE_URL" "$@"
exec npx -y "getmandate@$MANDATE_VERSION" "$@"
`;
}

/** Windows PowerShell installer (`irm <url>/install.ps1 | iex`). Same contract as the sh one. */
export function renderInstallPs1(i: InstallScriptInput): string {
  check(i);
  return `# Mandate installer for Windows PowerShell: wires your coding agents to a Mandate server.
#   irm ${i.url}${i.project ? `/p/${i.project}` : ''}/install.ps1 | iex
# This script contains no token or secret. Verify it first: ${i.url}${i.project ? `/p/${i.project}` : ''}/install.ps1.sha256
$ErrorActionPreference = 'Stop'
$MandateUrl = '${i.url}'
$MandateProject = '${i.project ?? ''}'
$MandateVersion = '${i.version}'
$PassArgs = @($args)

if ($MandateUrl -notmatch '^https://' -and $MandateUrl -notmatch '^http://(localhost|127\\.0\\.0\\.1)(:|$)' -and -not ($PassArgs -contains '--insecure')) {
  throw "refusing plain http ($MandateUrl): use the https URL, or pass --insecure"
}
if (-not $MandateProject -and -not ($PassArgs -contains '--project')) { throw "pass the project: & ([scriptblock]::Create((irm $MandateUrl/install.ps1))) --project <id>" }

Write-Host "Mandate installer (getmandate $MandateVersion)"
Write-Host "  server:  $MandateUrl"
if ($MandateProject) { Write-Host "  project: $MandateProject" }
Write-Host "This will add the Mandate MCP server, skills and commands to the coding agents found on this machine."
Write-Host "Sign-in: your agent opens GitHub sign-in on first use (MCP OAuth); no token is written."
Write-Host "It runs: npx -y getmandate@$MandateVersion connect --url $MandateUrl ..."

$node = Get-Command node -ErrorAction SilentlyContinue
$major = 0
if ($node) { $major = [int](& node -p 'process.versions.node.split(".")[0]') }
if ($major -lt 22) {
  Write-Host "Mandate needs Node.js 22 or newer. Nothing was changed."
  if (Get-Command volta -ErrorAction SilentlyContinue) { Write-Host "  volta install node@22" }
  elseif (Get-Command fnm -ErrorAction SilentlyContinue) { Write-Host "  fnm install 22; fnm use 22" }
  elseif (Get-Command nvm -ErrorAction SilentlyContinue) { Write-Host "  nvm install 22; nvm use 22" }
  else { Write-Host "  winget install OpenJS.NodeJS.LTS   (or https://nodejs.org)" }
  exit 1
}

$cli = @('connect', '--url', $MandateUrl)
if ($MandateProject) { $cli += @('--project', $MandateProject) }
if ($PassArgs -contains '--uninstall') { $cli += '--remove' }
$cli += ($PassArgs | Where-Object { $_ -notin @('--uninstall', '--insecure') })
& npx -y "getmandate@$MandateVersion" @cli
exit $LASTEXITCODE
`;
}

export const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
