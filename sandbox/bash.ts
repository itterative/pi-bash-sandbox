/**
 * Check if a value is a heredoc operator (<< or <<-)
 */
export function isHeredocOperator(value: string): boolean {
    return value === "<<" || value === "<<-";
}

/**
 * Check if a value is a subshell expression $(...) or `...`
 */
export function isSubshell(value: string): boolean {
    return (
        (value.startsWith("$(") && value.endsWith(")")) ||
        (value.startsWith("`") && value.endsWith("`"))
    );
}

/**
 * Check if a value is a process substitution <(...) or >(...)
 */
export function isProcessSubstitution(value: string): boolean {
    return (
        (value.startsWith("<(") || value.startsWith(">(")) &&
        value.endsWith(")")
    );
}

/**
 * Extract the content inside a subshell or process substitution
 */
export function getSubshellContent(value: string): string {
    if (value.startsWith("$(") && value.endsWith(")")) {
        return value.slice(2, -1);
    }

    if (value.startsWith("`") && value.endsWith("`")) {
        return value.slice(1, -1);
    }

    if (
        (value.startsWith("<(") || value.startsWith(">(")) &&
        value.endsWith(")")
    ) {
        return value.slice(2, -1);
    }

    return value;
}

/**
 * Parse a bash command into arguments.
 * This properly handles quoted strings, escaped spaces, subshells, process substitutions,
 * heredocs, and other bash syntax.
 */
export function parseBashArgs(command: string): string[] {
    const args: string[] = [];
    let current = "";
    let quote: string | null = null;
    let i = 0;

    while (i < command.length) {
        const char = command[i];

        if (quote) {
            if (char === quote && command[i - 1] !== "\\") {
                quote = null;
            } else {
                current += char;
            }
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === "$" && command[i + 1] === "(") {
            // Handle $(...) subshell - treat as single argument
            if (current) {
                args.push(current);
                current = "";
            }
            let depth = 1;
            let subshell = "$(";
            i += 2;
            while (i < command.length && depth > 0) {
                const c = command[i];
                if (c === "(") depth++;
                else if (c === ")") depth--;
                subshell += c;
                i++;
            }
            args.push(subshell);
            continue;
        } else if (char === "`") {
            // Handle `...` subshell - treat as single argument
            if (current) {
                args.push(current);
                current = "";
            }
            let subshell = "`";
            i++;
            while (i < command.length && command[i] !== "`") {
                subshell += command[i];
                i++;
            }
            if (i < command.length) {
                subshell += "`";
                i++;
            }
            args.push(subshell);
            continue;
        } else if ((char === "<" || char === ">") && command[i + 1] === "(") {
            // Handle <(...) and >(...) process substitution - treat as single argument
            if (current) {
                args.push(current);
                current = "";
            }
            let procSub = char + "(";
            let depth = 1;
            i += 2;
            while (i < command.length && depth > 0) {
                const c = command[i];
                if (c === "(") depth++;
                else if (c === ")") depth--;
                procSub += c;
                i++;
            }
            args.push(procSub);
            continue;
        } else if (char === "\\") {
            // Skip escaped character
            i++;
            current += command[i];
        } else if (char === "<" && command[i + 1] === "<") {
            // Handle heredoc operators: <<, <<-
            if (current) {
                args.push(current);
                current = "";
            }
            // Determine operator type
            let operator: string;
            let delimiter = "";
            if (command[i + 2] === "-") {
                operator = "<<-";
                i += 3;
            } else {
                operator = "<<";
                i += 2;
            }
            // Check if delimiter is attached (no space)
            if (i < command.length && !/\s/.test(command[i])) {
                // Delimiter is attached to operator, read it all
                while (i < command.length && !/\s/.test(command[i])) {
                    delimiter += command[i];
                    i++;
                }
            }
            // Always push operator and delimiter as separate args for consistent matching
            args.push(operator);
            if (delimiter) {
                args.push(delimiter);
            }

            // Skip heredoc content and find end delimiter
            if (delimiter) {
                // First, parse any remaining content on this line (e.g., | grep test)
                // until we hit a newline
                while (i < command.length && command[i] !== "\n") {
                    const lineChar = command[i];
                    if (lineChar === '"' || lineChar === "'") {
                        // Handle quoted strings on same line
                        const quote = lineChar;
                        i++;
                        while (i < command.length && command[i] !== quote) {
                            current += command[i];
                            i++;
                        }
                        i++; // skip closing quote
                    } else if (/\s/.test(lineChar)) {
                        if (current) {
                            args.push(current);
                            current = "";
                        }
                        i++;
                    } else {
                        current += lineChar;
                        i++;
                    }
                }
                if (current) {
                    args.push(current);
                    current = "";
                }

                // Now skip heredoc content until we find the end delimiter on its own line
                while (i < command.length) {
                    if (command[i] === "\n") {
                        const lineStart = i + 1;
                        const lineEnd = command.indexOf("\n", lineStart);
                        const line =
                            lineEnd === -1
                                ? command.slice(lineStart)
                                : command.slice(lineStart, lineEnd);

                        if (line === delimiter) {
                            // Found the end delimiter, include it
                            args.push(delimiter);
                            i = (lineEnd === -1 ? command.length : lineEnd) + 1;
                            break;
                        }
                        i = lineEnd === -1 ? command.length : lineEnd;
                    } else {
                        i++;
                    }
                }
            }
            // Continue to next iteration without the outer i++
            continue;
        } else if (char === "&" && command[i + 1] === "&") {
            // Handle && operator
            if (current) {
                args.push(current);
                current = "";
            }
            args.push("&&");
            i += 2;
            continue;
        } else if (char === "|" && command[i + 1] === "|") {
            // Handle || operator
            if (current) {
                args.push(current);
                current = "";
            }
            args.push("||");
            i += 2;
            continue;
        } else if (char === "|") {
            // Handle | (pipe) operator
            if (current) {
                args.push(current);
                current = "";
            }
            args.push("|");
            i++;
            continue;
        } else if (char === ";") {
            // Handle ; operator
            if (current) {
                args.push(current);
                current = "";
            }
            args.push(";");
            i++;
            continue;
        } else if (/\s/.test(char)) {
            if (current) {
                args.push(current);
                current = "";
            }
        } else {
            current += char;
        }

        i++;
    }

    if (current) args.push(current);
    return args;
}
