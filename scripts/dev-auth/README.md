# Developer auth for this repo

This repo authenticates to GitHub with short-lived tokens only. No password,
personal access token, or SSH key is ever saved on your machine.

## One-time setup

```bash
scripts/dev-auth/setup.sh
```

This points your local clone's `origin` at `https://github.com/labhacker007/HInS.git`
and configures git to fetch credentials through `git-credential-hins` instead
of macOS Keychain.

## Day to day

Just `git push` / `git pull` / `git fetch` as normal. The first time (and
again whenever your token has expired), git will:

1. Open github.com in your browser and show a short code (also copied to
   your clipboard).
2. You paste the code in and approve.
3. Git receives a token valid for about 8 hours and uses it for that whole
   window — no repeated prompts.

To sign out before the token expires:

```bash
git credential-cache exit
```

## How it works

- Auth is via the **HInS Dev Auth** GitHub App (device flow), installed only
  on the `labhacker007/HInS` repo.
- Tokens are GitHub App *user-to-server* tokens: they act as the developer
  who authorized them (commits are attributed to that person), scoped to
  whatever repos the app is installed on, and expire automatically (~8h).
- The token lives only in git's in-memory `credential-cache` helper
  (`timeout=28800`, matching the token lifetime) — never written to disk or
  Keychain. Restarting your machine or letting the cache time out clears it.
- `git-credential-hins` is installed to `~/.local/bin` (outside the repo) so
  a later `git pull` can't silently change the code that handles your
  credentials. Re-run `setup.sh` if you want to pick up an update to it.

## Revoking access

Remove the developer as a collaborator on the repo (or uninstall the GitHub
App for them specifically, if using fine-grained installation). Their
current token stops working immediately; there is nothing else to rotate.
