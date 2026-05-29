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
