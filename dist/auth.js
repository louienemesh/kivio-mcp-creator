import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
// On-disk token store. ~/.kivio/token is a plain JSON file with the
// long-lived creator JWT and the creator's display info. Permissions
// are set to 0600 so other users on a shared machine can't read it.
// Rotating the token: delete the file and re-run `kivio-mcp link <code>`.
const TOKEN_PATH = join(homedir(), '.kivio', 'token.json');
export function readToken() {
    if (!existsSync(TOKEN_PATH))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
        if (!parsed.token || !parsed.creatorId)
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
export function writeToken(t) {
    mkdirSync(dirname(TOKEN_PATH), { recursive: true });
    writeFileSync(TOKEN_PATH, JSON.stringify(t, null, 2));
    // Owner read-write only. Doesn't matter on Windows (chmod is a no-op).
    try {
        chmodSync(TOKEN_PATH, 0o600);
    }
    catch { /* non-fatal */ }
}
export function clearToken() {
    if (!existsSync(TOKEN_PATH))
        return;
    writeFileSync(TOKEN_PATH, '');
}
export function tokenPath() { return TOKEN_PATH; }
