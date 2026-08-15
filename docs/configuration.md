# Configuration

Configuration is stored in JSON files at:

- Project level: `.pi/bash-sandbox-config.json` (relative to working directory)
- Global level: `~/.pi/bash-sandbox-config.json`

The project-level config is merged with the global config, with project settings taking precedence. This allows you to have a base configuration globally and override specific settings per project.

_When no configuration exists, all commands default to `"ask"`, prompting you for each command. You can change this default using `"**"` in permissions — see [Permissions](./permissions.md)._ 

## JSON Schema

For IDE autocomplete and validation, add a `$schema` field to your config:

```json
{
    "$schema": "https://raw.githubusercontent.com/itterative/pi-bash-sandbox/refs/heads/main/docs/schema.json"
}
```

## Example Configuration

```json
{
    "$schema": "https://raw.githubusercontent.com/itterative/pi-bash-sandbox/refs/heads/main/docs/schema.json",
    "sandbox": {
        "mounts": {
            "/home/user/projects": "readwrite"
        },
        "env": {
            "API_KEY": "secret123"
        },
        "inheritEnv": {
            "MY_SECRET": "allow",
            "DEBUG": "deny"
        },
        "homeMounts": [".bashrc", ".config/git"]
    },
    "permissions": {
        "cd *": "allow",
        "ls *": "allow",
        "cat *": "allow",
        "sudo *": "deny",
        "rm -rf *": "deny",
        "find * | grep *": "allow",
        "find * -exec *": "ask"
    },
    "audit": {
        "provider": "openai",
        "model": "gpt-4o-mini"
    }
}
```

## Configuration Fields

### `sandbox.mounts` (optional)

- Additional filesystem paths to bind into the sandbox (these are **additive** to the default mounts)
- `"readonly"` - Bind as read-only
- `"readwrite"` - Bind with read-write access
- Paths use `--ro-bind-try` / `--bind-try`, so missing paths are silently skipped

#### Default Mounts

Every sandbox includes these automatic mounts:

| Path                                                                | Mode            | Notes                   |
| ------------------------------------------------------------------- | --------------- | ----------------------- |
| `/usr`, `/bin`, `/lib`, `/lib64`                                    | read-only       | System directories      |
| `/proc`                                                             | read-write      | Required for many tools |
| `/dev`                                                              | read-write      | New devtmpfs (safe)     |
| Current working directory                                           | read-write      | Project root            |
| `/etc/resolv.conf`, `/etc/hosts`                                    | read-only (try) | DNS resolution          |
| `/run/systemd/resolve`                                              | read-only (try) | Systemd DNS             |
| `/etc/ssl/certs`, `/etc/ca-certificates`, `/etc/pki`                | read-only (try) | SSL/TLS certificates    |
| `/etc/locale.conf`, `/etc/localtime`                                | read-only (try) | Locale/timezone         |
| `/etc/bashrc`, `/etc/bash.bashrc`, `/etc/profile`, `/etc/profile.d` | read-only (try) | Shell configs           |
| `/etc/bash_completion`, `/usr/share/bash-completion`                | read-only (try) | Bash completion         |
| `~/.bashrc`, `~/.bash_profile` (configurable)                       | read-only (try) | User shell configs      |
| `~/.local`, `~/.config` (configurable)                              | read-only (try) | User config directories |
| Main repo `.git/` (worktrees only)                                  | read-write      | Shared git object store |
| Worktree git dir `.git/worktrees/<name>/` (worktrees only)          | read-write      | Worktree-specific state |

### `sandbox.homeMounts` (optional)

Controls which files from the home directory are mounted into the sandbox:

- `true` (default) - Mount default home files (`.bashrc`, `.bash_profile`, `.local`, `.config`)
- `false` - Disable all home directory mounts
- `["path1", "path2", ...]` - Custom array of home paths to mount (relative to `~`)

**Merging behavior:** When both global and project configs define `homeMounts` as arrays, they are merged. Setting to `false` disables all home mounts entirely.

**Security note:** Home directories often contain sensitive files like API keys, credentials, and SSH keys. Consider limiting what's exposed to the sandbox.

**Example:**

```json
{
    "sandbox": {
        "homeMounts": [".bashrc", ".config/git"]
    }
}
```

### `sandbox.env` (optional)

- Custom environment variables to set in the sandbox
- These do NOT inherit from the parent process

### `sandbox.inheritEnv` (optional)

- Filter for which existing environment variables to pass through from the parent process
- `"allow"` - Include this variable from parent
- `"deny"` - Block this variable (even from defaults below)

**How it works:**

1. Custom `sandbox.env` variables are always set first
2. If `inheritEnv` is defined, only variables explicitly set to `"allow"` are passed from the parent
3. Default environment variables are set last (if not already set): `PWD`, `HOME`, `PATH`, `SHELL`, `TERM`, `USER`

**Important:** If you define `inheritEnv`, any environment variable not listed as `"allow"` will be blocked, with the exception of default environment variables. Use this to create a minimal environment.

### `audit` (optional)

- Configuration for the audit command's model analysis
- `provider` - The AI provider to use (e.g., "openai", "anthropic")
- `model` - The model ID to use (e.g., "gpt-4o", "claude-3-5-sonnet")
- If not specified, the current session model is used

### `heuristics` (optional)

Heuristics can grant a permission to commands that did **not** match any explicit
permission pattern (including `**`). They never override an explicit pattern match.

#### `heuristics.cwdConfinement` (optional)

Allows known, safe commands whose file accesses all resolve inside the working
directory (the folder pi was started from):

- `enabled` (default: `true`) - Whether the heuristic is active
- `permission` (default: `"allow:sandbox"`) - Permission granted when the heuristic applies (`"allow"` or `"allow:sandbox"`)
- `commands` (default: all known commands) - Restrict the heuristic to a subset of known commands
- `denyPaths` (default: `[]`) - Additional sensitive path segment patterns (glob, e.g. `"*.secret"`) that make the heuristic ineligible
- `blockDotfiles` (default: `false`) - Treat any dotfile/dotdir path segment as sensitive (paranoid mode)

**How it works:**

1. The command is parsed; every chained/piped command must be a *known* command
   (e.g. `cat`, `ls`, `head`, `tail`, `grep`, `find`, `sort`, `wc`, `du`, `echo`, `cd`, ...)
2. Using per-command argument knowledge, every path argument (positionals,
   path-valued flags, redirection targets, subshell contents) is resolved
   against the working directory
3. If all paths stay inside the working directory, the configured permission is
   granted; otherwise the command falls back to the permission system

Commands with dangerous flag usage are excluded even when known — e.g.
`find -delete`, `find -exec`, and `sort --compress-program` always fall back to
the permission system. Commands invoked by path (e.g. `./cat`, `/tmp/cat`) are
never trusted by the heuristic.

**Sensitive paths:** paths touching credential material always make the
heuristic ineligible. Matching is done per path segment of the resolved path,
so `cat src/.env` and `cat keys/server.pem` are caught. The built-in list
covers `.env*`, `.git`, credential directories (`.ssh`, `.aws`, `.gnupg`,
`.kube`, `.docker`, ...), credential files (`.netrc`, `.npmrc`, `.pgpass`, ...),
private keys (`id_rsa*`, `*.pem`, `*.key`, `*.p12`, ...), `*.tfvars`, and
`credentials`. Use `denyPaths` to add your own patterns (the built-in list
always applies) or `blockDotfiles` for a blanket dotfile ban. Note that this
check is path-based: commands that read whole directories (e.g. `grep -r .`)
can still *traverse into* sensitive files within the working directory.

**Example:**

```json
{
    "heuristics": {
        "cwdConfinement": {
            "enabled": true,
            "permission": "allow:sandbox",
            "commands": ["cat", "ls", "grep", "find"],
            "denyPaths": ["*.sqlite", "backups"],
            "blockDotfiles": false
        }
    }
}
```

**Limitations:**

- Path resolution is lexical; symlinks inside the working directory that point
  outside it are not detected
- Known commands are trusted to be the real system binaries found via `PATH`
- The sandbox does not isolate the network namespace

### `sandbox.gitWorktreeSupport` (optional)

Controls automatic detection and mounting of git worktree dependencies:

- `true` (default) - When the working directory is a git worktree, automatically mount the worktree-specific git directory and the main repository's `.git` directory
- `false` - Disable automatic worktree mounting

When enabled and the working directory is a git worktree (`.git` is a file containing a `gitdir:` pointer), the sandbox automatically adds:

| Mount | Mode | Purpose |
| ----- | ---- | ------- |
| Main repo `.git/` | read-write | Shared object store, refs — needed for commits, fetch, etc. |
| Worktree git dir (`.git/worktrees/<name>/`) | read-write | HEAD, index, and other worktree-specific state |

**Note:** Worktree detection requires that pi is started from the worktree root directory (where the `.git` file exists). Starting from a subdirectory will not detect the worktree.

**Example:**

```json
{
    "sandbox": {
        "gitWorktreeSupport": false
    }
}
```

### `permissions` (required)

- Command permissions - see [Permissions](./permissions.md)
