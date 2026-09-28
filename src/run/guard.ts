/**
 * Finds operations in PHP code that change data or have side effects, so
 * runs against production only ask for confirmation when it matters.
 * Heuristic by design: it errs towards asking.
 */
const WRITE_PATTERNS: Array<[RegExp, string]> = [
    [/->\s*(save|saveQuietly|saveOrFail|push|touch)\s*\(/i, 'save models'],
    [
        /->\s*(update|updateQuietly|updateOrFail|increment|decrement|incrementEach|decrementEach)\s*\(/i,
        'update records',
    ],
    [
        /->\s*(delete|deleteQuietly|deleteOrFail|forceDelete|forceDeleteQuietly|destroy|truncate|restore)\s*\(/i,
        'delete records',
    ],
    [/::\s*(destroy|truncate)\s*\(/i, 'delete records'],
    [
        /(::|->)\s*(create|createQuietly|createMany|forceCreate|firstOrCreate|updateOrCreate|updateOrInsert|upsert|insert|insertOrIgnore|insertGetId|insertUsing)\s*\(/i,
        'create records',
    ],
    [
        /->\s*(attach|detach|sync|syncWithoutDetaching|toggle|updateExistingPivot|associate|dissociate)\s*\(/i,
        'change relationships',
    ],
    [
        /\bDB\s*::\s*(statement|unprepared|affectingStatement|insert|update|delete)\s*\(/i,
        'run raw SQL',
    ],
    [/\bSchema\s*::/i, 'change the database schema'],
    [
        /\b(dispatch|dispatch_sync|dispatchSync|Bus\s*::|Queue\s*::|->\s*dispatch)\b/i,
        'dispatch jobs',
    ],
    [
        /\b(Mail|Notification)\s*::\s*(send|to|queue|route)\b|->\s*notify(Now)?\s*\(/i,
        'send mail or notifications',
    ],
    [/\b(Artisan\s*::\s*call|artisan\s*\()/i, 'run Artisan commands'],
    [
        /\b(Cache\s*::\s*(put|forget|flush|forever|increment|decrement|pull|add)|cache\(\)\s*->\s*(put|forget|flush))/i,
        'change the cache',
    ],
    [
        /\b(Storage\s*::|File\s*::\s*(put|delete|move|copy|append|prepend)|file_put_contents|unlink|rename)\b/i,
        'change files',
    ],
    [/\b(Http\s*::\s*(post|put|patch|delete))/i, 'call external services'],
    [/\b(event|broadcast)\s*\(/i, 'fire events'],
];

export function findWrites(code: string): string[] {
    const cleaned = stripCommentsAndStrings(code);
    const found = new Set<string>();
    for (const [pattern, label] of WRITE_PATTERNS) {
        if (pattern.test(cleaned)) found.add(label);
    }
    return [...found];
}

export type ConfirmPolicy = 'writes' | 'always' | 'never';

/** What to ask before running on production; undefined means run without asking. */
export function productionPrompt(
    code: string,
    policy: ConfirmPolicy,
): { writes: string[] } | undefined {
    if (policy === 'never') return undefined;
    const writes = findWrites(code);
    if (policy === 'always' || writes.length > 0) return { writes };
    return undefined;
}

function stripCommentsAndStrings(code: string): string {
    return code
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
        .replace(/#(?!\[).*$/gm, '')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}
