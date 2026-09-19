export const STAGED_IMAGE: RegExp;
export function filterDocxImages(ast: unknown, isStaged: (target: string) => boolean): { ast: unknown; warnings: string[] };
