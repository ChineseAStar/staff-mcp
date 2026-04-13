export function getWorkspaceArtifactPolicy(): string {
  return `
Workspace Artifact Policy:
Before creating any file, classify it as either a user-facing deliverable or an assistant-only working artifact.

Rules:
- User-facing deliverables should be placed according to the current task and the workspace's own conventions.
- Assistant-only working artifacts should be kept in a hidden assistant work area, defaulting to '.staff/', unless the workspace already defines another scratch location.
- Assistant-only working artifacts include temporary experiments, reproduction scripts, disposable test files, logs, progress notes, planning documents, checkpoints, derived metadata, and caches.
- Recommended default layout under '.staff/':
  - '.staff/tmp/' for temporary experiments and one-off outputs
  - '.staff/notes/' for plans, findings, and progress summaries
  - '.staff/logs/' for command output, traces, and runtime logs
  - '.staff/state/' for session or task state and checkpoints
  - '.staff/cache/' for reusable derived data that is not part of the deliverable
- Do not mix assistant-only working artifacts with user deliverables unless explicitly requested.
- If unsure whether a file is a deliverable, treat it as an assistant-only working artifact first.
- If the target workspace already has explicit conventions for generated or scratch material, follow those conventions instead of the default hidden layout.
`.trim();
}
