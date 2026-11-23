# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/midorima66/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/midorima66/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write, in all four formats they
write them in: unified diffs (with possibly wrong line numbers), SEARCH/REPLACE blocks, V4A
patches, and text-editor tool calls as JSON. It finds the lines an edit names even when the
model drifted their whitespace or indentation (three matching tiers, with re-indentation at the
loosest tier), and it changes every file or none.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

Node 22, standard library only. `main.ts` is the CLI; `runner.ts` beside it is the kit's trial
runner, kept as it is. MIT licensed.
