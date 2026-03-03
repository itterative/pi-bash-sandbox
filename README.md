# pi-bash-sandbox

Bash sandboxing for pi - a secure way to execute shell commands with configurable permissions and filesystem isolation.

## Features

- **Sandboxed command execution** using [bubblewrap](https://github.com/containers/bubblewrap)
- **Configurable permissions** - allow, deny, ask, or sandbox specific commands
- **Filesystem isolation** - bind-mounted directories with read-only or read-write access
- **Pattern-based matching** - use wildcards to match command patterns
- **User notes** - add context to your decisions that the agent can see

## Requirements

- Linux platform
- `bubblewrap` (bwrap) package installed

*If bubblewrap is not installed, the extension will display a warning and disable the sandbox option.*

## Usage

When the agent attempts to run a bash command, you'll be prompted based on your permission settings:

- **Yes (sandbox)** - Run inside a bubblewrap sandbox
- **Yes** - Run directly without sandboxing
- **No** - Block the command

Press **Tab** on an option to add an optional note explaining your decision.

### Commands

- `/bash-sandbox-config` - Display or reload the sandbox configuration
- `/bash-sandbox-audit` - Analyze allowed commands and suggest permission patterns

## Configuration

Configuration is stored in JSON files:

- Project level: `.pi/bash-sandbox-config.json`
- Global level: `~/.pi/bash-sandbox-config.json`

### Quick Example

```json
{
    "sandbox": {
        "mounts": {
            "/home/user/projects": "readwrite"
        }
    },
    "permissions": {
        "cd *": "allow",
        "ls *": "allow",
        "npm run *": "allow",
        "sudo *": "deny",
        "rm -rf *": "deny"
    }
}
```

## Documentation

- [Configuration](./docs/configuration.md) - Full configuration options, sandbox mounts, environment variables
- [Permissions](./docs/permissions.md) - Permission levels, pattern matching, advanced syntax
