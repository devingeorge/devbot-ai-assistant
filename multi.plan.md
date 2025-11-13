<!-- 6cdd1275-76a9-435c-95b2-9eaa78d98a74 7c1b1507-2b24-4045-bd00-2c20995646d0 -->
# Multi‑Org Preflight Plan (Updated)

## What we’ll do

- Enable and verify OAuth mode in production without breaking current token mode.
- Constrain legacy data migration so new orgs don’t inherit existing data (restricted to current install only).
- Extend installation storage TTL to 60 days (from 30) to reduce unexpected token loss.
- Add uninstall handling to clean up installation and (optionally) per-team data.
- Validate current workspace via OAuth reinstall, then test a second org.

## Steps

1. OAuth readiness (no user impact)

- Set envs: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_STATE_SECRET`, `SLACK_BOT_SCOPES`.
- Ensure redirect URL in Slack app: `https://YOUR_DOMAIN/slack/oauth_redirect`.
- Enable App Distribution and confirm scopes align with usage.

2. Extend installation TTL

- Update Redis installation store to use 60‑day TTL for `installation:<team|enterprise>`.

3. Constrain legacy migration (current install only)

- Restrict `LEGACY_TEAM_IDS` to your current enterprise/workspace only; remove any other IDs.
- Before inviting external installs, clear it entirely (or keep it limited strictly to prod org) so new orgs never inherit prod data.

4. Deploy and verify OAuth endpoints

- Redeploy; confirm `/slack/oauth_start` responds.

5. Reinstall current workspace via OAuth

- Complete the OAuth install; verify prompts, key‑phrases, system prompts, assistant DM, and monitored channels.

6. Install to a second org

- Perform install; verify data isolation and chat flows. Confirm no legacy migration logs appear for the new org.

7. Uninstall handling

- Add `app_uninstalled` handler: delete the installation record and (optionally) purge per-team data (suggested prompts, key‑phrases, user system prompts) to avoid orphaned entries.

## Notes

- Dual‑mode boot remains: token mode when OAuth envs are absent; OAuth mode when present.
- Optional enhancement: refresh installation TTL on token access to reduce expiry risk further.

### To-dos

- [ ] Add OAuth config to app.js with dual-mode boot
- [ ] Align redisService installation methods with Bolt signatures
- [ ] Add redirect URL, enable distribution, set scopes
- [ ] Set SLACK_CLIENT_ID/SECRET/STATE_SECRET/BOT_SCOPES in prod
- [ ] Reinstall app via OAuth in current workspace
- [ ] Install to another org; verify data isolation

