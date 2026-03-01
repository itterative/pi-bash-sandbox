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

#### Example Configuration

```json
{
    "sandbox": {
        "mounts": {
            "~/.bashrc": "readonly",
            "~/.bashrc.d": "readonly",
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
    }
}
```

#### Configuration Fields

**`sandbox.mounts`** (optional)

- Additional filesystem paths to bind into the sandbox
- `"readonly"` - Bind as read-only
- `"readwrite"` - Bind with read-write access

**`sandbox.env`** (optional)

- Custom environment variables to set in the sandbox
- These do NOT inherit from the parent process

**`sandbox.inheritEnv`** (optional)

- Filter for which existing environment variables to pass through
- `"allow"` - Include this variable from parent
- `"deny"` - Block this variable
- By default, the following envs are set: PWD, HOME, PATH, SHELL, TERM, USER

**`permissions`** (required)

- Command permissions (see below)

### Permission Patterns

Permissions use wildcard patterns where `*` matches zero or more characters within an argument.

Patterns are matched on last-match basis (similar to OpenCode). This means that you should define your catch-all at the top, and be more specific as you add permissions.

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

#### Advanced Pattern Matching

##### Wildcards

The `*` wildcard matches zero or more characters **within a single argument**. When `*` appears as its own argument in the pattern, it matches one or more command arguments:

```json
{
    "permissions": {
        "npm run test:*": "allow",
        "npm run *": "allow",
        "git * *": "allow"
    }
}
```

| Pattern          | Command                    | Match                      |
| ---------------- | -------------------------- | -------------------------- |
| `npm run test:*` | `npm run test:unit`        | ✅                         |
| `npm run test:*` | `npm run test:integration` | ✅                         |
| `npm run *`      | `npm run build`            | ✅                         |
| `npm run *`      | `npm run dev server`       | ✅ (matches multiple args) |
| `git commit *`   | `git commit -m "message"`  | ✅                         |

##### Heredocs

Heredoc syntax (`<<`, `<<-`) is fully supported. The delimiter name is flexible - any delimiter in the command will match any delimiter in the pattern:

```json
{
    "permissions": {
        "cat << EOF": "allow",
        "git commit << *": "allow"
    }
}
```

| Pattern              | Command                            | Match                   |
| -------------------- | ---------------------------------- | ----------------------- |
| `cat << EOF`         | `cat <<EOF\ncontent\nEOF`          | ✅                      |
| `cat << EOF`         | `cat <<MYDELIM\ncontent\nMYDELIM`  | ✅ (any delimiter)      |
| `cat <<- EOF`        | `cat <<-EOF\ncontent\nEOF`         | ✅                      |
| `cat << EOF`         | `cat <<-EOF\n...`                  | ❌ (different operator)  |
| `cat << EOF \| bash` | `cat << EOF \| bash\ncontent\nEOF` | ✅                      |
| `cat << EOF \| grep` | `cat << EOF \| bash\ncontent\nEOF` | ❌ (different command)   |

##### Subshells

Subshells (`$(...)` and `` `...` ``) are parsed and matched recursively:

```json
{
    "permissions": {
        "echo $(echo hello)": "allow",
        "echo $(echo *)": "allow",
        "echo $(cat *)": "allow"
    }
}
```

| Pattern                 | Command                        | Match                        |
| ----------------------- | ------------------------------ | ---------------------------- |
| `echo $(echo *)`        | `echo $(echo hello)`           | ✅                           |
| `echo $(echo *)`        | `echo $(echo world)`           | ✅                           |
| `echo $(cat *)`         | `echo $(cat file.txt)`         | ✅                           |
| `echo $(cat *)`         | `echo $(echo file.txt)`        | ❌ (different inner command)  |
| `echo $(cat $(echo *))` | `echo $(cat $(echo file.txt))` | ✅ (nested)                  |

##### Process Substitution

Process substitution (`<(...)` and `>(...)`) is also supported:

```json
{
    "permissions": {
        "diff <(cat *) <(cat *)": "allow"
    }
}
```

| Pattern                  | Command                          | Match |
| ------------------------ | -------------------------------- | ----- |
| `diff <(cat *) <(cat *)` | `diff <(cat a.txt) <(cat b.txt)` | ✅    |

##### Command Chaining

Operators like `&&`, `||`, `|`, and `;` are parsed as separate arguments:

```json
{
    "permissions": {
        "cat * && rm *": "allow",
        "cat * | grep *": "allow"
    }
}
```

| Pattern           | Command                       | Match               |
| ----------------- | ----------------------------- | ------------------- |
| `cat * && rm *`   | `cat file.txt && rm file.txt` | ✅                  |
| `cat *`           | `cat file.txt && rm file.txt` | ❌ (has extra args)  |
| `cat * \| grep *` | `cat file.txt \| grep foo`    | ✅                  |

##### Redirections

Redirections (`>`, `>>`, `<`, `2>`, `2>&1`) are parsed as separate arguments:

```json
{
    "permissions": {
        "cat * > *": "allow",
        "cat * >> *": "allow"
    }
}
```

| Pattern     | Command                      | Match                   |
| ----------- | ---------------------------- | ----------------------- |
| `cat * > *` | `cat file.txt > output.txt`  | ✅                      |
| `cat * > *` | `cat file.txt >> output.txt` | ❌ (different operator)  |
