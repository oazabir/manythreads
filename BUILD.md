\# Context

Build the project according to PLAN.md

Understand how much has been built from STATUS.md

Resume from the last completed Phase \& Task. 



Generate or refresh CLAUDE.md. AGENTS.md symlink to/from CLAUDE.md.

Record progress in STATUS.md

Avoid mistakes in MISTAKES.md

Record new mistakes in MISTAKES.md in terse format. When this file grows beyond 4KB, compact it.



\# Coding
Follow WINDOWS\_DEV.md to setup and do regular development.



# Testing

During mobile and web verification steps, take screenshots as evidence of working features. Implement necessary authentication bypassing for testing and screenshot taking.

Take screenshots using playwright on the `ssh devbox` and scp the screenshots into local folder temp/screenshots/

Then create an temp/screenshots/index.html file with all the latest screenshots. Open it in browser to show progress.



# Token efficiency

Mobile and Web code build and test produce large output. Read only what is necessary.

Save token as much as possible.

Compact context after every phase.



\# Loop efficiency

Before beginning a phase, reflect on the work done so far and decide whether some refactoring would make it more efficient to implement the current phase.

End of every phase, refresh CLAUDE.md



Every 5 mins check for background tasks that are stuck and not making progress. Recover them.

