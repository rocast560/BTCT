export interface Diagnostic { severity: 'error' | 'warning'; message: string; file: string | null; line: number | null; col: number | null }
export interface ChildResult { code?: number | string | null; signal?: string | null; killed?: boolean; stderr?: string }
export function parseDiagnostics(stderr: string, root: string): Diagnostic[];
export function scrubPaths(text: string, root: string): string;
export function childFailureMessage(result: ChildResult | null, tool: string): string | null;
