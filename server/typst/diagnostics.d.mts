export interface Diagnostic { severity: 'error' | 'warning'; message: string; file: string | null; line: number | null; col: number | null }
export function parseDiagnostics(stderr: string, root: string): Diagnostic[];
