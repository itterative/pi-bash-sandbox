# pi-bash-sandbox

Bash sandboxing for pi - a secure way to execute shell commands with configurable permissions and filesystem isolation.

## Features

- **Sandboxed command execution** using [bubblewrap](https://github.com/containers/bubblewrap) for Linux/FBSD
- **Configurable permissions** - allow, deny, ask, or sandbox specific commands
- **Filesystem isolation** - bind-mounted directories with read-only or read-write access
- **Pattern-based matching** - use wildcards to match command patterns (last-match takes precedence)
- **Configurable at multiple levels** - project-specific or global configuration

## Requirements

- Linux or FreeBSD platform
- `bubblewrap` (bwrap) package installed

## Usage

This extension integrates with the pi coding agent to intercept and control bash command execution. When the agent attempts to run a bash command, you'll be prompted based on your permission settings.

### Configuration

Configuration is stored in JSON files at:
- Project level: `.pi/bash-sandbox-config.json` (relative to working directory)
- Global level: `~/.pi/bash-sandbox-config.json`

#### Config File Structure

```json
{
  "mounts": {
    "/path/to/source": "readonly",
    "/path/to/other": "readwrite"
  },
  "permissions": {
    "command pattern": "permission level"
  }
}
```

### Permission Patterns

Permissions use wildcard patterns where `*` matches at least one character.

Paterns are matched on last-match basis (similar to OpenCode). This means that you should define your catch-all at the top, and be more specific as you add permissions.

#### Permission Levels

- `allow` - Execute command directly without sandboxing
- `allow:sandbox` - Execute command within a bubblewrap sandbox
- `deny` - Block the command entirely
- `ask` (default) - Ask permission for each command

```json
{
  "permissions": {
    "npm test": "allow",
    "npm test *": "allow",
    "npm run test:*": "allow",
    "ls *": "allow",
    "sudo *": "deny",
    "docker *": "ask"
  }
}
```

### Mount Configuration

Mounts define additional filesystem paths to bind into the sandbox:
- `"readonly"` - Bind as read-only
- `"readwrite"` - Bind with read-write access

### Example Configuration

```json
{
  "mounts": {
    "~/.bashrc": "readonly",
    "~/.bashrc.d": "readonly",
  },
  "permissions": {
    "*": "ask",
    "cd *": "allow",
    "ls *": "allow",
    "cat *": "allow",
    "sudo *": "deny",
    "rm -rf *": "deny",
    "* | *": "ask",
    "find * | grep *": "allow"
  }
}
```
