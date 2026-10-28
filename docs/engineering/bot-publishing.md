# How a tested change reaches GitHub

The path a finished change takes from a green test run to the manythreads repository on GitHub — and why no bot ever holds the GitHub token.

## 1. Tester proves the commit
Tester checks out the exact commit — the numbered snapshot of the code the change is made in — and runs the checks and tests that cover it there. A change moves on only when those checks pass at that commit; the run at the exact commit is the proof the change is green.

## 2. Engineer hands the card over
Engineer hands the card — the task on the team's board that names the branch and the proved commit — to Committer, with the commit recorded so what was tested is what gets published.

## 3. Committer opens the pull request
Committer pushes the branch and opens a pull request — a proposed merge into `main` — through the platform's publish command. The platform holds the GitHub token and does the push with it; Committer never sees the token.

## 4. A person merges
A person reads the pull request and merges it into `main`. That is the last step of this page: the change is on GitHub, and the pipeline that runs on the merge takes it from there.
