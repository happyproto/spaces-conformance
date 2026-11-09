/** One validation failure, located well enough to fix. */
export interface Problem {
  file: string;
  /** Assertion id, array index or JSON pointer within the file. */
  where?: string;
  message: string;
}

export function formatProblem(p: Problem): string {
  return `${p.file}${p.where ? ` [${p.where}]` : ''}: ${p.message}`;
}
