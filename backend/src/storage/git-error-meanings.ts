const PATH_ABSENT_AT_COMMIT_SUBSTRINGS = [
  "does not exist",
  "exists on disk, but not in",
];

const REVISION_RESOLVES_TO_NO_COMMIT_SUBSTRINGS = [
  "unknown revision",
  "does not have any commits",
  "bad revision",
  "ambiguous argument",
  "invalid object name 'head'",
];

export function gitErrorMeansPathAbsentAtCommit(message: string): boolean {
  const lowered = message.toLowerCase();
  return PATH_ABSENT_AT_COMMIT_SUBSTRINGS.some((substring) => lowered.includes(substring));
}

export function gitErrorMeansRevisionResolvesToNoCommit(message: string): boolean {
  const lowered = message.toLowerCase();
  return REVISION_RESOLVES_TO_NO_COMMIT_SUBSTRINGS.some((substring) => lowered.includes(substring));
}
