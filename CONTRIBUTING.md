# Contributing to CC-Viewer

The author welcomes and encourages PRs from the community. The author also doesn't mind if you distill features from this project into your own applications.

## Requirements

- When submitting a PR, please tell me what your **Prompt** was and which **model** you used to modify the code (PRs made with inferior models will not be accepted);
- If there are UI changes, tell me what functionality was modified on the interface — a **screenshot with circles** drawn around the changes is recommended;
- Changes to `cli.js`, `findcc.js`, and `server/interceptor.js` will be reviewed very carefully, as I don't want issues in core files to affect everyone's usage;
- Please make sure to **verify the functionality locally** before submitting — much appreciated!
- ⚠️ `server/_paths.js` is **physically position-sensitive**: every constant is anchored on the file's own URL (`HERE = dirname(import.meta.url)`). Moving this file with `git mv` produces no static error but shifts `PACKAGE_ROOT` / `NODE_MODULES` / `DIST_DIR` etc. Any change to its location must be followed by manual verification of every import site's resolved path.
