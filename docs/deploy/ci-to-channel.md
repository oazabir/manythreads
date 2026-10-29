# Send CI results to a channel

You can make a build, a deploy, an alert or any script post into a channel. You do it with an **incoming webhook**: a private web address that belongs to one channel. Whatever a program sends to that address shows up in the channel as a message from the webhook (for example "GitHub Actions"), with a small **Webhook** mark.

You must be a lead of the channel's team or a workspace admin to make one. The plugin's details are in [plugins/webhooks.md](../plugins/webhooks.md).

## 1. Make the webhook

1. Open the channel and press **Webhooks** in the header.
2. Type a name (it becomes the author name of the messages), optionally an emoji, and press **Make webhook**.
3. Copy the address now. It looks like `https://your-site/hooks/<id>/<secret>`. **It is shown only once**: manythreads keeps only a fingerprint of the secret, so nobody (including you) can read it back later. If you lose it, press **New address** on that webhook; the old address stops working at once.
4. Press **Send test message**. A note from the webhook appears in the channel.

Anyone who has the address can post into the channel, so treat it like a password: keep it in your CI's secret store, not in the code.

## 2. GitHub Actions: a step that reports the result

Store the address as a repository secret named `MANYTHREADS_WEBHOOK_URL` (Settings, Secrets and variables, Actions). Then add a last step that always runs:

```yaml
      - name: Tell the channel
        if: always()
        env:
          HOOK: ${{ secrets.MANYTHREADS_WEBHOOK_URL }}
          STATUS: ${{ job.status }}
        run: |
          curl --fail-with-body -sS -X POST "$HOOK" \
            -H 'Content-Type: application/json' \
            -d "$(jq -n \
              --arg title "${GITHUB_WORKFLOW} on ${GITHUB_REF_NAME}" \
              --arg text "${GITHUB_ACTOR} pushed ${GITHUB_SHA::7}" \
              --arg status "$STATUS" \
              --arg url "${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" \
              '{title: $title, text: $text, status: $status, url: $url}')"
```

`status` may be `success`, `failure`, `cancelled` or `warning`; the message gets a matching mark. `jq` builds the JSON so quotes in a commit message cannot break it.

## 3. Let GitHub itself send events

Instead of a step in every workflow, GitHub can call the address for pushes, pull requests, issues, finished workflow runs and releases.

1. In the repository: Settings, Webhooks, **Add webhook**.
2. **Payload URL**: the address you copied. **Content type**: `application/json`.
3. **Secret** (recommended): on the webhook in manythreads press **Add signing secret**, copy the secret shown, and paste it here. From then on the webhook refuses any call that is not signed with it, so a leaked address alone is not enough.
4. Choose the events you want (or "Let me select": Pushes, Pull requests, Issues, Workflow runs, Releases).

Events the webhook does not show are answered with a normal success and skipped, so GitHub does not mark the delivery as failed.

## 4. GitLab, alerts and scripts

- **GitLab**: Settings, Webhooks. Paste the address as the URL. If you added a signing secret, paste it as the **Secret token**.
- **Alertmanager**: add a `webhook_configs` receiver with `url:` set to the address.
- **Sentry**: add a webhook integration or an alert rule action that posts to the address.
- **Any script** (plain text works too):

  ```sh
  curl -X POST "$HOOK" -H 'Content-Type: text/plain' --data 'Nightly backup finished'
  curl -X POST "$HOOK" -H 'Content-Type: application/json' \
    -d '{"title":"Deploy","text":"v1.4.2 is live","status":"success","url":"https://example.com/releases/1.4.2","fields":[{"title":"Env","value":"production"}]}'
  ```

The JSON fields are `text`, and optionally `title`, `url`, `status` (`success`, `failed`, `warning`, `info`) or `color`, and `fields` (a list of `{title, value}`). Slack and Mattermost style bodies (`text` with `attachments`) work as they are, so an existing script that posts to Slack needs only a new address.

## Limits and safety

- A body can be up to 1 MB. A webhook accepts 120 calls a minute; the next one gets `429` with a `Retry-After` header.
- Text from outside never pings anyone: an `@name` in it is shown as plain text, and raw HTML is removed.
- Make a call with the wrong or an old address and you get `404`, always the same answer, so nobody can tell a wrong secret from a switched-off webhook.
- **Switch off** a webhook for good from the same dialog. Rotating or switching off is recorded in the audit log, with who did it, together with failed attempts (at most one line a minute per webhook).
- On a self-hosted install the web server must pass `/hooks/` to the app (the supplied nginx config and Helm chart do).
