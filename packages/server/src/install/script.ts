/**
 * The one-line installer a Mandate server serves (`curl -fsSL <server>/p/<project>/install.sh | sh`, PowerShell:
 * `irm <server>/p/<project>/install.ps1 | iex`). It installs the Mandate CLI (`getmandate`) at the server's EXACT
 * version FROM THE SERVER ITSELF (`<server>/getmandate.tgz`, sha256-checked; the npm registry is never asked for
 * getmandate, so neither an unpublished package nor a compromised npm "latest" matters), with `npm install -g` (or,
 * without write access to npm's global folder, into `~/.mandate/cli`), then runs its `connect`. The script holds no
 * secret: only the server URL, the project id, the version and the tarball's checksum. Agents sign in with GitHub
 * through MCP OAuth on first use; nothing secret is written.
 *
 * `<server>/uninstall.sh` (`.ps1`) undoes it: `getmandate uninstall`, then removes the CLI.
 */
import { createHash } from 'node:crypto';

export interface InstallScriptInput {
  /** Origin agents reach (the public HTTPS URL, or http://localhost:<port> on this computer). */
  url: string;
  /** Project id, or null for the generic script (`--project` then required). */
  project: string | null;
  /** Exact getmandate version to install. */
  version: string;
  /** sha256 of `<url>/getmandate.tgz` when known (embedded: verifying the script then pins the CLI too); else the
   * script fetches `<url>/getmandate.tgz.sha256`. */
  cliSha256?: string | null;
  /** The project has strict flow on: pass --strict-flow to connect (installs the `mandate guard` edit hook). */
  strictFlow?: boolean;
}

const PROJECT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA_RE = /^[0-9a-f]{64}$/;

function checkUrl(url: string): void {
  const u = new URL(url);
  if (u.origin !== url || !/^https?:$/.test(u.protocol)) throw new Error('installer: the URL must be a bare http(s) origin');
}

function check(i: InstallScriptInput): void {
  checkUrl(i.url);
  if (i.project !== null && !PROJECT_RE.test(i.project)) throw new Error('installer: invalid project id');
  if (!VERSION_RE.test(i.version)) throw new Error('installer: invalid version');
  if (i.cliSha256 && !SHA_RE.test(i.cliSha256)) throw new Error('installer: invalid checksum');
}

/* Shared sh helpers: download (curl, wget or node), sha256 (node: always there), find the installed CLI. */
const SH_HELPERS = `say() { printf '%s\\n' "$*"; }
die() { printf 'mandate: %s\\n' "$*" >&2; exit 1; }
# fetch <url> <file>
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else node -e 'fetch(process.argv[1]).then(async (r) => { if (!r.ok) throw new Error("HTTP " + r.status); require("fs").writeFileSync(process.argv[2], Buffer.from(await r.arrayBuffer())); }).catch((e) => { console.error(e.message); process.exit(1); })' "$1" "$2"
  fi
}
sha256() { node -e 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; }
# npm's global prefix. \`npm prefix -g\` masks UUID-like path segments as *** in what it prints: then ask a child it spawns.
npm_global_prefix() {
  p=$(npm prefix -g 2>/dev/null || true)
  if [ -z "$p" ] || [ ! -d "$p" ]; then p=$(npm exec -c 'printf "%s\\n" "$npm_config_global_prefix"' </dev/null 2>/dev/null | tail -n 1 || true); fi
  [ -n "$p" ] && [ -d "$p" ] && printf '%s\\n' "$p"
}
# The installed CLI: the per-user install (~/.mandate/cli) first, else getmandate on PATH, else in npm's global bin.
find_cli() {
  if [ -x "$CLI_PREFIX/bin/getmandate" ]; then printf '%s\\n' "$CLI_PREFIX/bin/getmandate"
  elif command -v getmandate >/dev/null 2>&1; then command -v getmandate
  else
    g=$(npm_global_prefix || true)
    if [ -n "$g" ] && [ -x "$g/bin/getmandate" ]; then printf '%s\\n' "$g/bin/getmandate"; else return 1; fi
  fi
}`;

/** POSIX sh installer (no secrets; `set -eu`; prints what it will do first; the body runs once fully read). */
export function renderInstallSh(i: InstallScriptInput): string {
  check(i);
  const base = `${i.url}${i.project ? `/p/${i.project}` : ''}`;
  return `#!/bin/sh
# Mandate installer: installs the Mandate CLI (getmandate) from this server and wires your coding agents to it.
#   curl -fsSL ${base}/install.sh | sh
#   ... | sh -s -- --agents claude-code,codex --dry-run      (flags go to \`getmandate connect\`)
#   ... | sh -s -- --uninstall                              (removes the agent wiring again; the CLI stays)
#   ... | sh -s -- --reinstall                              (reinstall the CLI even if this build is installed)
# Remove the wiring and the CLI: curl -fsSL ${i.url}/uninstall.sh | sh
# This script contains no token or secret. Verify it first: ${base}/install.sh.sha256
set -eu

MANDATE_URL='${i.url}'
MANDATE_PROJECT='${i.project ?? ''}'
MANDATE_VERSION='${i.version}'
# sha256 of $MANDATE_URL/getmandate.tgz (empty: read from $MANDATE_URL/getmandate.tgz.sha256).
MANDATE_CLI_SHA256='${i.cliSha256 ?? ''}'

${SH_HELPERS}

main() {
UNINSTALL=0
YES=0
INSECURE=0
DRY=0
REINSTALL=0
REPO_FLAG=''
for a in "$@"; do
  case "$a" in
    --uninstall) UNINSTALL=1 ;;
    --yes|-y) YES=1 ;;
    --insecure) INSECURE=1 ;;
    --dry-run) DRY=1 ;;
    --reinstall) REINSTALL=1 ;;
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

CLI_PREFIX="\${MANDATE_HOME:-$HOME/.mandate}/cli"
CLI_URL="$MANDATE_URL/getmandate.tgz"
# Build identity of the installed CLI: "<sha256 of the tarball it came from> <path>". The version string alone is not
# enough (every build of a version prints the same --version): an older build would rewrite the agent files with its
# older text.
BUILD_MARKER="\${MANDATE_HOME:-$HOME/.mandate}/cli-build"

say "Mandate installer (getmandate $MANDATE_VERSION)"
say "  server:  $MANDATE_URL"
if [ -n "$MANDATE_PROJECT" ]; then say "  project: $MANDATE_PROJECT"; fi
if [ "$UNINSTALL" = 1 ]; then
  say "This will remove the Mandate MCP server entry from your coding agents (and this repo's wiring)."
  say "The getmandate command stays; to remove it too: curl -fsSL $MANDATE_URL/uninstall.sh | sh"
else
  say "This will:"
  say "  - install the Mandate CLI, getmandate $MANDATE_VERSION, from $CLI_URL (checksum-verified, npm install -g;"
  say "    without write access to npm's global folder: into $CLI_PREFIX);"
  say "  - for every coding agent found on this machine (Claude Code, Codex, Cursor, ...):"
  say "    add the Mandate MCP server ($MANDATE_URL/p/<project>/mcp) to its user config,"
  say "    and the Mandate skills and the /mandate, /mandate-flow, /mandate-bootstrap commands;"
  say "  - sign-in: your agent opens GitHub sign-in on first use (MCP OAuth); no token is written."
  say "It runs: getmandate connect --url $MANDATE_URL ..."
  say "Remove it all later: curl -fsSL $MANDATE_URL/uninstall.sh | sh"
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
command -v npm >/dev/null 2>&1 || die "npm not found (it ships with Node.js)"

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
    --uninstall|--insecure|--repo|--no-repo|--reinstall) ;;
    *) set -- "$@" "$a" ;;
  esac
  i=$((i + 1))
done
if [ "$UNINSTALL" = 1 ]; then set -- --remove "$@"; fi
set -- "$REPO_FLAG" "$@"
if [ -n "$MANDATE_PROJECT" ]; then set -- --project "$MANDATE_PROJECT" "$@"; fi
${i.strictFlow ? 'set -- --strict-flow "$@"\n' : ''}set -- connect --url "$MANDATE_URL" "$@"

TMPD=$(mktemp -d 2>/dev/null || mktemp -d -t mandate)
trap 'rm -rf "$TMPD"' EXIT
trap 'exit 130' INT TERM
TGZ=''
# The sha256 of this server's CLI tarball (embedded, else read from $CLI_URL.sha256).
want_sha() {
  want=$MANDATE_CLI_SHA256
  if [ -z "$want" ]; then
    fetch "$CLI_URL.sha256" "$TMPD/sum" || die "could not download $CLI_URL.sha256"
    want=$(cut -d ' ' -f 1 <"$TMPD/sum")
  fi
}
# Download the CLI tarball and check its sha256; nothing is installed on a mismatch.
get_tgz() {
  TGZ="$TMPD/getmandate-$MANDATE_VERSION.tgz"
  say "Downloading $CLI_URL"
  fetch "$CLI_URL" "$TGZ" || die "could not download $CLI_URL"
  want_sha
  got=$(sha256 "$TGZ")
  [ "$got" = "$want" ] || die "checksum mismatch for $CLI_URL (expected $want, got $got); nothing was installed"
  say "  sha256 ok ($got)"
}
npm_user() {
  mkdir -p "$CLI_PREFIX"
  if ! npm install -g --prefix "$CLI_PREFIX" --no-fund --no-audit --loglevel=error "$TGZ" >"$TMPD/npm.log" 2>&1 </dev/null; then
    tail -n 20 "$TMPD/npm.log" >&2
    die "npm install into $CLI_PREFIX failed"
  fi
  CLI="$CLI_PREFIX/bin/getmandate"
}

CLI=''
HAVE=''
SAME_BUILD=0
if FOUND=$(find_cli); then HAVE=$("$FOUND" --version 2>/dev/null | tail -n 1 || true); fi
if [ "$HAVE" = "$MANDATE_VERSION" ] && [ "$REINSTALL" = 0 ] && [ "$UNINSTALL" = 0 ] && [ -f "$BUILD_MARKER" ]; then
  want_sha
  [ "$(head -n 1 "$BUILD_MARKER")" = "$want $FOUND" ] && SAME_BUILD=1
fi
if [ "$UNINSTALL" = 1 ] && [ -n "$HAVE" ]; then
  CLI=$FOUND
elif [ "$SAME_BUILD" = 1 ]; then
  CLI=$FOUND
  say "getmandate $HAVE is already installed ($FOUND, same build)."
elif [ "$DRY" = 1 ] || [ "$UNINSTALL" = 1 ]; then
  # Change nothing on this machine: run this version once from the verified tarball (npm exec cache).
  get_tgz
  if [ "$DRY" = 1 ]; then say "(dry run) would install getmandate $MANDATE_VERSION: npm install -g $CLI_URL"; fi
  set +e
  npm exec --yes --package="$TGZ" -- getmandate "$@"
  code=$?
  exit "$code"
else
  get_tgz
  if [ "$HAVE" = "$MANDATE_VERSION" ]; then say "Updating getmandate $HAVE to this server's build"
  elif [ -n "$HAVE" ]; then say "Upgrading getmandate $HAVE -> $MANDATE_VERSION"; else say "Installing getmandate $MANDATE_VERSION"; fi
  if [ -x "$CLI_PREFIX/bin/getmandate" ]; then
    npm_user # an earlier per-user install: upgrade it in place
  elif npm install -g --no-fund --no-audit --loglevel=error "$TGZ" >"$TMPD/npm.log" 2>&1 </dev/null; then
    CLI="$(npm_global_prefix || true)/bin/getmandate"
  else
    say "npm install -g failed (no write access to npm's global folder?):"
    tail -n 3 "$TMPD/npm.log" | sed 's/^/    /'
    say "Installing for this user only, into $CLI_PREFIX"
    npm_user
  fi
  [ -x "$CLI" ] || die "installed, but $CLI is missing"
  mkdir -p "$(dirname "$BUILD_MARKER")" && printf '%s %s\n' "$got" "$CLI" >"$BUILD_MARKER"
  say "Installed getmandate $MANDATE_VERSION ($CLI)."
  BIN_DIR=$(dirname "$CLI")
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      say "To run getmandate from any terminal, add its folder to your PATH (e.g. in ~/.profile, ~/.bashrc or ~/.zshrc):"
      say "  export PATH=\\"$BIN_DIR:\\$PATH\\""
      ;;
  esac
fi
say ""

set +e
"$CLI" "$@"
code=$?
exit "$code"
}

main "$@"
`;
}

/** Windows PowerShell installer (`irm <url>/install.ps1 | iex`). Same contract as the sh one. */
export function renderInstallPs1(i: InstallScriptInput): string {
  check(i);
  const base = `${i.url}${i.project ? `/p/${i.project}` : ''}`;
  return `# Mandate installer for Windows PowerShell: installs the Mandate CLI (getmandate) from this server and wires your
# coding agents to it.
#   irm ${base}/install.ps1 | iex
# Remove the wiring and the CLI: irm ${i.url}/uninstall.ps1 | iex
# This script contains no token or secret. Verify it first: ${base}/install.ps1.sha256
$ErrorActionPreference = 'Stop'
$MandateUrl = '${i.url}'
$MandateProject = '${i.project ?? ''}'
$MandateVersion = '${i.version}'
# sha256 of $MandateUrl/getmandate.tgz (empty: read from $MandateUrl/getmandate.tgz.sha256).
$MandateCliSha256 = '${i.cliSha256 ?? ''}'
$PassArgs = @($args)

if ($MandateUrl -notmatch '^https://' -and $MandateUrl -notmatch '^http://(localhost|127\\.0\\.0\\.1)(:|$)' -and -not ($PassArgs -contains '--insecure')) {
  throw "refusing plain http ($MandateUrl): use the https URL, or pass --insecure"
}
if (-not $MandateProject -and -not ($PassArgs -contains '--project')) { throw "pass the project: & ([scriptblock]::Create((irm $MandateUrl/install.ps1))) --project <id>" }

$MandateHome = if ($env:MANDATE_HOME) { $env:MANDATE_HOME } else { Join-Path $HOME '.mandate' }
$CliPrefix = Join-Path $MandateHome 'cli'
$CliUrl = "$MandateUrl/getmandate.tgz"
# Build identity of the installed CLI ("<tarball sha256> <path>"): the version alone does not tell builds apart.
$BuildMarker = Join-Path $MandateHome 'cli-build'
$Uninstall = $PassArgs -contains '--uninstall'
$DryRun = $PassArgs -contains '--dry-run'
$Reinstall = $PassArgs -contains '--reinstall'

Write-Host "Mandate installer (getmandate $MandateVersion)"
Write-Host "  server:  $MandateUrl"
if ($MandateProject) { Write-Host "  project: $MandateProject" }
if ($Uninstall) {
  Write-Host "This will remove the Mandate MCP server entry from your coding agents. The getmandate command stays;"
  Write-Host "to remove it too: irm $MandateUrl/uninstall.ps1 | iex"
} else {
  Write-Host "This will install the Mandate CLI, getmandate $MandateVersion, from $CliUrl (checksum-verified, npm install -g;"
  Write-Host "without write access to npm's global folder: into $CliPrefix), then add the Mandate MCP server, skills and"
  Write-Host "commands to the coding agents found on this machine."
  Write-Host "Sign-in: your agent opens GitHub sign-in on first use (MCP OAuth); no token is written."
  Write-Host "It runs: getmandate connect --url $MandateUrl ..."
  Write-Host "Remove it all later: irm $MandateUrl/uninstall.ps1 | iex"
}

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
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm not found (it ships with Node.js)" }

$cli = @('connect', '--url', $MandateUrl)
if ($MandateProject) { $cli += @('--project', $MandateProject) }
if ($Uninstall) { $cli += '--remove' }
${i.strictFlow ? "$cli += '--strict-flow'\n" : ''}$cli += @($PassArgs | Where-Object { $_ -notin @('--uninstall', '--insecure', '--reinstall') })

function Find-MandateCli {
  $p = Join-Path $CliPrefix 'getmandate.cmd'
  if (Test-Path $p) { return $p }
  $c = Get-Command getmandate -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  return $null
}
# npm's global prefix (\`npm prefix -g\` masks UUID-like path segments as *** in what it prints: then ask a child it spawns).
function Get-NpmPrefix {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $p = [string]((& npm prefix -g 2>$null) | Select-Object -Last 1)
    if (-not $p -or -not (Test-Path $p)) { $p = [string]((& npm exec -c 'echo %npm_config_global_prefix%' 2>$null) | Select-Object -Last 1) }
  } finally { $ErrorActionPreference = $prev }
  if ($p -and (Test-Path $p.Trim())) { return $p.Trim() }
  return $null
}
# npm writes warnings to stderr: never let them stop the script; the exit code decides.
function Invoke-Npm([string[]]$NpmArgs, [string]$Log) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & npm @NpmArgs 2>&1 | Out-File -FilePath $Log -Encoding utf8 } finally { $ErrorActionPreference = $prev }
  return $LASTEXITCODE
}

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("mandate-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Tmp | Out-Null
$code = 0
try {
  $tgz = Join-Path $Tmp "getmandate-$MandateVersion.tgz"
  $wantSha = {
    $w = $MandateCliSha256
    if (-not $w) { $w = ([string](Invoke-RestMethod -UseBasicParsing -Uri "$CliUrl.sha256")).Trim().Split(' ')[0] }
    $w.ToLower()
  }
  $getTgz = {
    Write-Host "Downloading $CliUrl"
    Invoke-WebRequest -UseBasicParsing -Uri $CliUrl -OutFile $tgz
    $want = & $wantSha
    $script:got = (Get-FileHash -Path $tgz -Algorithm SHA256).Hash.ToLower()
    if ($script:got -ne $want) { throw "checksum mismatch for $CliUrl (expected $want, got $($script:got)); nothing was installed" }
    Write-Host "  sha256 ok ($($script:got))"
  }
  $found = Find-MandateCli
  $have = ''
  if ($found) { try { $have = ([string](& $found --version | Select-Object -Last 1)).Trim() } catch { $have = '' } }
  $exe = $null
  $sameBuild = $false
  if ($have -eq $MandateVersion -and -not $Reinstall -and -not $Uninstall -and (Test-Path $BuildMarker)) {
    $sameBuild = ([string](Get-Content $BuildMarker -TotalCount 1)).Trim() -eq "$(& $wantSha) $found"
  }
  if ($Uninstall -and $have) { $exe = $found }
  elseif ($sameBuild) { $exe = $found; Write-Host "getmandate $have is already installed ($found, same build)." }
  elseif ($DryRun -or $Uninstall) {
    # Change nothing on this machine: run this version once from the verified tarball (npm exec cache).
    & $getTgz
    if ($DryRun) { Write-Host "(dry run) would install getmandate $($MandateVersion): npm install -g $CliUrl" }
    & npm exec --yes "--package=$tgz" -- getmandate @cli
    $code = $LASTEXITCODE
  } else {
    & $getTgz
    if ($have -eq $MandateVersion) { Write-Host "Updating getmandate $have to this server's build" } elseif ($have) { Write-Host "Upgrading getmandate $have -> $MandateVersion" } else { Write-Host "Installing getmandate $MandateVersion" }
    $log = Join-Path $Tmp 'npm.log'
    $userInstall = Test-Path (Join-Path $CliPrefix 'getmandate.cmd')
    if (-not $userInstall) {
      if ((Invoke-Npm @('install', '-g', '--no-fund', '--no-audit', '--loglevel=error', $tgz) $log) -eq 0) {
        $exe = Join-Path ([string](Get-NpmPrefix)) 'getmandate.cmd'
      } else {
        Write-Host "npm install -g failed (no write access to npm's global folder?):"
        Get-Content $log -Tail 3 | ForEach-Object { Write-Host "    $_" }
        Write-Host "Installing for this user only, into $CliPrefix"
        $userInstall = $true
      }
    }
    if ($userInstall) {
      New-Item -ItemType Directory -Force -Path $CliPrefix | Out-Null
      if ((Invoke-Npm @('install', '-g', '--prefix', $CliPrefix, '--no-fund', '--no-audit', '--loglevel=error', $tgz) $log) -ne 0) {
        Get-Content $log -Tail 20 | ForEach-Object { Write-Host $_ }
        throw "npm install into $CliPrefix failed"
      }
      $exe = Join-Path $CliPrefix 'getmandate.cmd'
    }
    if (-not (Test-Path $exe)) { throw "installed, but $exe is missing" }
    New-Item -ItemType Directory -Force -Path $MandateHome | Out-Null
    Set-Content -Path $BuildMarker -Value "$($script:got) $exe"
    Write-Host "Installed getmandate $MandateVersion ($exe)."
    $binDir = Split-Path $exe -Parent
    if (-not (($env:Path -split ';') -contains $binDir)) {
      Write-Host "To run getmandate from any terminal, add its folder to your user PATH:"
      Write-Host "  [Environment]::SetEnvironmentVariable('Path', '$binDir;' + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')"
    }
  }
  if ($exe) {
    Write-Host ""
    & $exe @cli
    $code = $LASTEXITCODE
  }
} finally {
  Remove-Item -Recurse -Force -Path $Tmp -ErrorAction SilentlyContinue
}
exit $code
`;
}

export interface UninstallScriptInput {
  /** The serving Mandate's origin (shown in the script's header only). */
  url: string;
}

/** POSIX sh uninstaller: `getmandate uninstall` (flags pass through), then removes the CLI. */
export function renderUninstallSh(i: UninstallScriptInput): string {
  checkUrl(i.url);
  return `#!/bin/sh
# Mandate uninstaller: removes the Mandate agent wiring and service (\`getmandate uninstall\`), then the getmandate CLI.
#   curl -fsSL ${i.url}/uninstall.sh | sh
#   ... | sh -s -- --dry-run        (show what would be removed; changes nothing)
#   ... | sh -s -- --purge --yes    (also delete ~/.mandate: config, keys, indexes, sessions)
# This script contains no token or secret. Verify it first: ${i.url}/uninstall.sh.sha256
set -eu

${SH_HELPERS}

main() {
DRY=0
for a in "$@"; do
  case "$a" in --dry-run) DRY=1 ;; esac
done
CLI_PREFIX="\${MANDATE_HOME:-$HOME/.mandate}/cli"
if ! CLI=$(find_cli); then
  say "getmandate is not installed on this machine: nothing to remove."
  exit 0
fi
say "Mandate uninstaller"
say "  CLI: $CLI"
set +e
"$CLI" uninstall "$@"
code=$?
set -e
[ "$code" = 0 ] || die "getmandate uninstall failed (exit $code); the CLI was kept"

GLOBAL_ROOT=$(npm_global_prefix || true)
if [ -n "$GLOBAL_ROOT" ]; then GLOBAL_ROOT="$GLOBAL_ROOT/lib/node_modules"; fi
if [ "$DRY" = 1 ]; then
  if [ -x "$CLI_PREFIX/bin/getmandate" ]; then say "(dry run) would remove the getmandate CLI in $CLI_PREFIX"; fi
  if [ -n "$GLOBAL_ROOT" ] && [ -e "$GLOBAL_ROOT/getmandate" ]; then say "(dry run) would run: npm uninstall -g getmandate"; fi
  exit 0
fi
if [ -d "$CLI_PREFIX" ]; then
  npm uninstall -g --prefix "$CLI_PREFIX" --loglevel=error getmandate >/dev/null 2>&1 </dev/null || true
  rm -rf "$CLI_PREFIX"
  say "Removed the getmandate CLI ($CLI_PREFIX). If you added $CLI_PREFIX/bin to your PATH, you can remove that line."
fi
if [ -n "$GLOBAL_ROOT" ] && [ -e "$GLOBAL_ROOT/getmandate" ]; then
  if npm uninstall -g --loglevel=error getmandate </dev/null; then say "Removed the getmandate CLI (npm uninstall -g getmandate)."
  else die "could not remove the global getmandate package; try: sudo npm uninstall -g getmandate"
  fi
fi
rm -f "\${MANDATE_HOME:-$HOME/.mandate}/cli-build"
say "Done."
}

main "$@"
`;
}

/** Windows PowerShell uninstaller (`irm <url>/uninstall.ps1 | iex`). Same contract as the sh one. */
export function renderUninstallPs1(i: UninstallScriptInput): string {
  checkUrl(i.url);
  return `# Mandate uninstaller for Windows PowerShell: removes the Mandate agent wiring and service (\`getmandate uninstall\`),
# then the getmandate CLI.
#   irm ${i.url}/uninstall.ps1 | iex
#   & ([scriptblock]::Create((irm ${i.url}/uninstall.ps1))) --dry-run     (or --purge --yes)
# This script contains no token or secret. Verify it first: ${i.url}/uninstall.ps1.sha256
$ErrorActionPreference = 'Stop'
$PassArgs = @($args)
$MandateHome = if ($env:MANDATE_HOME) { $env:MANDATE_HOME } else { Join-Path $HOME '.mandate' }
$CliPrefix = Join-Path $MandateHome 'cli'
$DryRun = $PassArgs -contains '--dry-run'

$cliPath = $null
$p = Join-Path $CliPrefix 'getmandate.cmd'
if (Test-Path $p) { $cliPath = $p } else { $c = Get-Command getmandate -ErrorAction SilentlyContinue; if ($c) { $cliPath = $c.Source } }
if (-not $cliPath) { Write-Host "getmandate is not installed on this machine: nothing to remove."; exit 0 }
Write-Host "Mandate uninstaller"
Write-Host "  CLI: $cliPath"
& $cliPath uninstall @PassArgs
if ($LASTEXITCODE -ne 0) { throw "getmandate uninstall failed (exit $LASTEXITCODE); the CLI was kept" }

$globalRoot = ''
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  $gp = [string]((& npm prefix -g 2>$null) | Select-Object -Last 1)
  if (-not $gp -or -not (Test-Path $gp)) { $gp = [string]((& npm exec -c 'echo %npm_config_global_prefix%' 2>$null) | Select-Object -Last 1) }
  if ($gp) { $globalRoot = Join-Path $gp.Trim() 'node_modules' }
} catch { $globalRoot = '' } finally { $ErrorActionPreference = $prev }
$hasGlobal = $globalRoot -and (Test-Path (Join-Path $globalRoot 'getmandate'))
if ($DryRun) {
  if (Test-Path $p) { Write-Host "(dry run) would remove the getmandate CLI in $CliPrefix" }
  if ($hasGlobal) { Write-Host "(dry run) would run: npm uninstall -g getmandate" }
  exit 0
}
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  if (Test-Path $CliPrefix) {
    & npm uninstall -g --prefix $CliPrefix --loglevel=error getmandate 2>&1 | Out-Null
    Remove-Item -Recurse -Force -Path $CliPrefix -ErrorAction SilentlyContinue
    Write-Host "Removed the getmandate CLI ($CliPrefix)."
  }
  Remove-Item -Force -Path (Join-Path (Split-Path $CliPrefix -Parent) 'cli-build') -ErrorAction SilentlyContinue
  if ($hasGlobal) {
    & npm uninstall -g --loglevel=error getmandate
    if ($LASTEXITCODE -ne 0) { throw "could not remove the global getmandate package; run: npm uninstall -g getmandate" }
    Write-Host "Removed the getmandate CLI (npm uninstall -g getmandate)."
  }
} finally { $ErrorActionPreference = $prev }
Write-Host "Done."
`;
}

export const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
