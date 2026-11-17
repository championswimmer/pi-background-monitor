# Background monitoring workflows

## Outcome
Make existing one-shot and repeated-command monitoring discoverable without adding a separate scheduler: Bash jobs already support loops, journal inspection and live output filters. A shell loop gives approximate cadence and a soft deadline, not a hard timeout or guaranteed fixed scheduling. Inspection pages bounded retained output; it is not a native grep API.

## Phases
- [x] Inspect tools, lifecycle, tests and Pi's installed extension documentation.
- [x] Explain both user workflows, callback delivery, paging and loop limitations in README and reference.
- [x] Update compact selected-tool prompt and tool descriptions; add integration coverage for the loop, retained inspection and callback.
- [x] Run focused and project checks, document results and limitations.

## Verification hypothesis
A repeated finite Bash command should emit multiple samples, including a regex match; a retained watch with wake delivery should report it and inspection should return those samples. Failure disproves the documented composition. Prompt tests must ensure guidance appears only with the relevant tools.

## Results and limits
Linux, Node 26.13.0 and tmux 3.6: focused workflow and prompt tests passed; `npm run check`, `npm run lint` (18 pre-existing warnings), `npm test` (108/108), `npm pack --dry-run` and `git diff --check` passed. The first lint run caught formatting in the new prompt, which was fixed. The integration test observes wake submission, not an actual model response. No macOS test was run. Loops are not a hard-deadline scheduler, watches are live-session only, and log retention and delivery are bounded/best effort.
