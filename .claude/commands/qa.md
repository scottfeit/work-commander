---
description: Run the QA agent, fix everything it reports, then have it re-run the full suite until clean
argument-hint: "[max rounds, default 3]"
---

Run a QA-and-remediation loop on Work Commander. Max rounds: $ARGUMENTS (default 3).

1. **First pass.** Invoke the `qa-tester` subagent (first-pass mode). Ask it to run its whole procedure and return its full report.
2. **Triage.** For each finding, decide: real app bug / wrong test / not worth fixing. Fix test problems in `qa/tests`. Never delete or weaken a test just to make it pass. If a finding needs a product decision (not an obvious bug), ask the user instead of guessing.
3. **Remediate.** Fix every real finding in the application code, highest severity first. Keep each fix minimal and root-cause, and run `npm run typecheck && npm test` after the changes.
4. **Commit** the fixes with a message listing the finding IDs.
5. **Verify.** Invoke `qa-tester` again in verify mode, passing the previous report path, so it re-runs **all** QA (static checks, the full automated suite, exploratory checks) and not just the failures.
6. **Repeat** from step 2 while the verify report says `RESULT: <n> OPEN`, up to the max rounds. Stop immediately on `RESULT: CLEAN`.
7. **Finish** with a short summary for the user: rounds taken, findings fixed (grouped by severity), anything left open or needing their decision, and the path of the final report. Push to `main` only if the user has asked for pushes in this session.
