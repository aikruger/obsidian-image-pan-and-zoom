export function parseArgumentTemplate(template: string): string[] {
    const args: string[] = [];
    let currentArg = "";
    let inQuotes = false;

    for (let i = 0; i < template.length; i++) {
        const char = template[i];

        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ' ' && !inQuotes) {
            if (currentArg.length > 0) {
                args.push(currentArg);
                currentArg = "";
            }
        } else {
            currentArg += char;
        }
    }

    if (inQuotes) {
        throw new Error("Unmatched quotes in argument template.");
    }

    if (currentArg.length > 0) {
        args.push(currentArg);
    }

    // Reject templates without {file}
    if (!args.some(arg => arg.includes('{file}'))) {
        throw new Error("Argument template must contain '{file}' placeholder.");
    }

    return args;
}

export function buildArguments(template: string, filePath: string): string[] {
    const tokens = parseArgumentTemplate(template);
    return tokens.map(token => {
        // Fallback for replaceAll if target es version doesn't support it
        return token.split('{file}').join(filePath);
    });
}
