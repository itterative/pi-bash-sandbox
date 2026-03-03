# Configuration

Configuration is stored in JSON files at:

- Project level: `.pi/bash-sandbox-config.json` (relative to working directory)
- Global level: `~/.pi/bash-sandbox-config.json`

The project-level config is merged with the global config, with project settings taking precedence. This allows you to have a base configuration globally and override specific settings per project.

*When no configuration exists, all commands default to `"ask"`, prompting you for each command.*

## Example Configuration

```json
{
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
        }
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
| `/usr`, `/bin`, `/lib`, `/lib64`, `/etc`                            | read-only       | System directories      |
| `/proc`                                                             | read-write      | Required for many tools |
| `/dev`                                                              | read-write      | Device access           |
| `/run/systemd/resolve`                                              | read-only (try) | DNS resolution          |
| Current working directory                                           | read-write      | Project root            |
| `/etc/bashrc`, `/etc/bash.bashrc`, `/etc/profile`, `/etc/profile.d` | read-only (try) | Shell configs           |
| `/etc/bash_completion`, `/usr/share/bash-completion`                | read-only (try) | Bash completion         |
| `~/.bashrc`, `~/.bash_profile`, `~/.bash_history`                   | read-only (try) | User shell configs      |
| `~/.local`, `~/.config`                                             | read-only (try) | User config directories |

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

### `permissions` (required)

- Command permissions - see [Permissions](./permissions.md)
