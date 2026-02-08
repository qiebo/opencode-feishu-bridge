# Security Notes

## Secrets

- Runtime secrets must be stored in `.env.runtime` only.
- `.env.runtime` is ignored by git via `.gitignore`.
- Do not place real credentials in source files, scripts, or docs.

## If a Secret Was Exposed

1. Rotate the secret in Feishu developer console.
2. Update `.env.runtime` with the new value.
3. Restart service:
   ```bash
   systemctl --user restart opencode-feishu-bridge.service
   ```

## Repository Hygiene

- Keep `logs/`, `node_modules/`, `dist/`, and local config files out of commits.
- Review diffs before push:
  ```bash
  git status
  git diff --staged
  ```
