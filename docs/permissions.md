# Permissions

Permissions control how bash commands are handled when the agent attempts to execute them.

## Permission Levels

- `allow` - Execute command directly without sandboxing
- `allow:sandbox` - Execute command within a bubblewrap sandbox
- `deny` - Block the command entirely
- `ask` (default) - Ask permission for each command

When a command matches `ask` (or has no matching rule), you'll see a prompt with:

- **Yes (sandbox)** - Run the command inside a bubblewrap sandbox
- **Yes** - Run the command directly without sandboxing
- **No** - Block the command

## User Notes

When prompted, you can add an optional message to explain your decision:

- Press **Tab** on an option to enter inline edit mode
- Type your message (e.g., "trusted build tool" or "too risky")
- Press **Enter** to confirm with the message

Your note is shared with the agent to provide context about your preferences:

- **Blocked commands**: The note appears in the block reason
- **Allowed commands**: The note is prefixed with `[User note: ...]` at the start of the command output
- **Audit log**: Notes are stored with allowed commands for later review

## Pattern Matching

Permissions use wildcard patterns where `*` matches zero or more characters within an argument.

Patterns are matched on last-match basis (similar to OpenCode). This means that you should define your catch-all at the top, and be more specific as you add permissions.

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

### Multi-Line Commands

Commands separated by newlines are parsed as separate commands. The permission system evaluates each command independently and returns the **most restrictive** result:

- If any command is `deny` → returns `deny`
- If any command is `ask` → returns `ask`
- Otherwise returns the most restrictive among `allow`/`allow:sandbox`

**Example configuration:**

```json
{
    "permissions": {
        "echo *": "allow",
        "ls *": "allow:sandbox",
        "rm *": "deny"
    }
}
```

**All allowed → `allow`:**

```bash
echo hello
echo world
```

**Mixed allow/allow:sandbox → `allow:sandbox`:**

```bash
echo hello
ls -la
```

**One denied → `deny`:**

```bash
echo hello
rm file
```

**Unknown command → `ask`:**

```bash
ls -la
sudo apt update
```

### Line Continuations

Lines ending with `\` are joined together before parsing:

**Matches `echo hello world`:**

```bash
echo hello \
world
```

**Does not match `echo hello world`:**

```bash
echo hello \
&& rm file
```

This parses as `echo hello && rm file` (a chained command).

## Advanced Pattern Matching

### Wildcards

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

### Heredocs

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

### Subshells

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

### Process Substitution

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

### Command Chaining

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

### Redirections

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
