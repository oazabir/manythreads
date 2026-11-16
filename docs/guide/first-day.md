# Your first day: the setup wizard

This guide walks the setup wizard from a fresh install to a first job done by bots. The wizard is at Settings, Workspace, Setup (`/onboarding`), and the sidebar card
"Finish setting up" opens it. Only workspace admins see it. You can leave at any step and come back: the page opens at the step you stopped at, and the address
`?step=models` opens a named step.

A **bot** is a team member that is a program. A **runner** is a place where bots run. **Brain** is the built-in assistant bot. A step is ticked only when the thing is
really true (a model that answered a test, a runner that answered a real question), never because you pressed a button.

| Step | What you do | Can you skip it? |
|---|---|---|
| 0 Your sign-in | Nothing: you are signed in as the owner. | no |
| 1 Pick a look | Try Classic, Graphite, Linen or Harbor, in light or dark. It is yours alone; everyone picks their own. | yes |
| 2 Your organization | Name it, choose its short name and time zone, press Save. | no |
| 3 Address and HTTPS | Read the address people use. To move to your own domain later, run `sudo manythreads set-domain <name>` on the machine. | yes |
| 4 Models | Pick where the models come from (an API key, a coding plan, or a model on your own machine), paste the key and press Connect. Then press Test on `smart`. | no |
| 5 Sign-in methods | Add Google or Microsoft sign-in, or confirm that passwords are what you want. | yes |
| 6 Teams | Every team template is ticked. Untick what you do not want and press Make. | no |
| 7 Servers | Name a machine of your own and run the one command it shows on it. | yes |
| 8 Runners | A runner must answer a real question before you can finish. With none, press "Deploy it and ask a real question": the wizard makes a Hermes pod on the models of step 4. | no |
| 9 Where bots run | Choose the runner bots use unless a bot says otherwise. | no |
| 10 Code | Add a Git repository to the team (the starter repository is a good first one). | yes |
| 11 Check that Brain answers | Ask Brain a question and watch its steps. | no |
| 12 A first delivery | Give the Engineer a small job on the starter repository and watch the team deliver it. | yes |

If a step fails, it names the cause in one sentence (a wrong key, no quota left, a pod that is not ready yet) and offers to try again. The model test and the runner test
use a little of your provider's budget; step 4 sets a monthly spending limit (25 US dollars unless you change it) so a loop cannot run up a bill.

When every required step is done the card reads "Setup is done" and you can put it away.
