// Where the provider CLIs live.
//
// By default each is looked up on PATH, which is right when `npm run dev` is
// started from a shell. It is not right when the server is launched from a GUI,
// a launchd/LaunchAgent plist or a systemd unit: those inherit a minimal PATH
// without the user's shell additions, so a perfectly installed `codex` is
// simply not found. Each binary can therefore be pointed at explicitly, the
// same way ZOTERO_MCP_BIN works for the MCP server.
//
// Values are paths, not shell commands — they are passed to spawn() without a
// shell, so no quoting or argument splitting is applied to them.

const bin = (envVar: string, fallback: string) => process.env[envVar]?.trim() || fallback;

export const claudeBin = () => bin("CLAUDE_BIN", "claude");
export const codexBin = () => bin("CODEX_BIN", "codex");
export const opencodeBin = () => bin("OPENCODE_BIN", "opencode");
