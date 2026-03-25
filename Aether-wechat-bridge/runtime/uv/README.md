Place bundled `uv` binaries here for WeChat bridge runtime setup.

Expected layout:

- `uv-0.6.14-aarch64-apple-darwin/uv`
- `uv-0.6.14-x86_64-apple-darwin/uv`
- `uv-0.6.14-x86_64-unknown-linux-gnu/uv`

These files are copied into release artifacts via `packages/opencode/script/build.ts` when `Aether-wechat-bridge` is bundled.
