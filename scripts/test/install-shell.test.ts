import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// install-shell.sh edits the user's real ~/.zshrc and ~/.tmux.conf, so the
// risky parts (legacy-region removal, idempotence, backups) are proven here
// against a throwaway HOME before the script is ever pointed at the real one.

const REPO = join(import.meta.dir, "..", "..");
const INSTALLER = join(REPO, "scripts", "install-shell.sh");

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "metamux-install-shell-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function run() {
  const proc = Bun.spawnSync(["bash", INSTALLER], {
    env: { ...process.env, HOME: home, ZDOTDIR: home },
  });
  const stderr = new TextDecoder().decode(proc.stderr);
  if (proc.exitCode !== 0) throw new Error(`installer failed (${proc.exitCode}): ${stderr}`);
  return new TextDecoder().decode(proc.stdout);
}

const read = (name: string) => readFileSync(join(home, name), "utf8");
const backups = (name: string) => readdirSync(home).filter((f) => f.startsWith(`${name}.metamux-bak-`));
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

// The shape of the pre-migration ~/.zshrc: an earlier `# fi` that must NOT be
// mistaken for the picker region's terminator, the picker region itself, and
// the loose daemon-ensure line further down.
const LEGACY_ZSHRC = `export PATH="/usr/local/bin:$PATH"

# if [[ -n $SOMETHING ]]; then
#   echo unrelated
# fi

# --- tmux session picker (shared by SSH login and the \`t\` shortcut) ---
_tmux_go() {
  tmux new -A -s "$1"
}
t() {
  _tmux_pick
}

# if [[ -z $REMOTE_SESSION ]]; then
#   t
# fi

# >>> grok installer >>>
export PATH="$HOME/.grok/bin:$PATH"
# <<< grok installer <<<

# metamux: ensure the daemon is running (cmux shells only, keeps socket features on)
[ -n "$CMUX_WORKSPACE_ID" ] && (bash ~/Documents/GitHub/metamux/scripts/ensure-daemon.sh >/dev/null 2>&1 &)
`;

const LEGACY_TMUX_CONF = `set -g prefix C-a

# Touch-only switching (Termius accessory F-keys, no prefix).
bind -n F1 previous-window
set -g @jumpnav 1
bind -n Left if-shell '[ "#{@jumpnav}" = 1 ]' \\
  'display-popup -E "zsh -ic _tmux_pick"' \\
  'send-keys Left'

set -g status-style "bg=#152744"
`;

describe("install-shell.sh", () => {
  test("removes the legacy picker region without eating the earlier # fi block", () => {
    writeFileSync(join(home, ".zshrc"), LEGACY_ZSHRC);
    run();
    const zshrc = read(".zshrc");

    expect(zshrc).not.toContain("tmux session picker");
    expect(zshrc).not.toContain("_tmux_go()");
    // The unrelated commented block above the region survives intact.
    expect(zshrc).toContain("#   echo unrelated");
    // So does everything else that was never ours.
    expect(zshrc).toContain("# >>> grok installer >>>");
    expect(zshrc).toContain('export PATH="/usr/local/bin:$PATH"');
  });

  test("removes the loose daemon-ensure line and re-provides it via the block", () => {
    writeFileSync(join(home, ".zshrc"), LEGACY_ZSHRC);
    run();
    const zshrc = read(".zshrc");

    expect(zshrc).not.toContain("ensure-daemon.sh");
    expect(zshrc).toContain(`source "${REPO}/shell/metamux.zsh"`);
  });

  test("moves the tmux binds out and leaves theming in place", () => {
    writeFileSync(join(home, ".tmux.conf"), LEGACY_TMUX_CONF);
    run();
    const conf = read(".tmux.conf");

    expect(conf).not.toContain("bind -n F1");
    expect(conf).not.toContain("@jumpnav");
    expect(conf).toContain("set -g prefix C-a");
    expect(conf).toContain('set -g status-style "bg=#152744"');
    expect(conf).toContain(`source-file "${REPO}/shell/metamux.tmux.conf"`);
  });

  test("is idempotent: a second run writes nothing and adds no blank-line drift", () => {
    writeFileSync(join(home, ".zshrc"), LEGACY_ZSHRC);
    writeFileSync(join(home, ".tmux.conf"), LEGACY_TMUX_CONF);
    run();
    const afterFirst = read(".zshrc");
    const backupsAfterFirst = backups(".zshrc").length;

    const output = run();

    expect(read(".zshrc")).toBe(afterFirst);
    expect(output).toContain("already current");
    expect(backups(".zshrc").length).toBe(backupsAfterFirst);
    expect(count(afterFirst, "# >>> metamux >>>")).toBe(1);
  });

  test("backs up before the first write only", () => {
    writeFileSync(join(home, ".zshrc"), LEGACY_ZSHRC);
    run();
    expect(backups(".zshrc").length).toBe(1);
    expect(readFileSync(join(home, backups(".zshrc")[0]), "utf8")).toBe(LEGACY_ZSHRC);
  });

  test("installs into a home with no dotfiles yet", () => {
    run();
    expect(read(".zshrc")).toBe(
      `# >>> metamux >>>\nsource "${REPO}/shell/metamux.zsh"\n# <<< metamux <<<\n`,
    );
    expect(read(".tmux.conf")).toContain(`source-file "${REPO}/shell/metamux.tmux.conf"`);
    expect(backups(".zshrc").length).toBe(0);
  });

  test("re-points the block when the repo moves, without duplicating it", () => {
    writeFileSync(
      join(home, ".zshrc"),
      '# >>> metamux >>>\nsource "/old/path/metamux/shell/metamux.zsh"\n# <<< metamux <<<\n',
    );
    run();
    const zshrc = read(".zshrc");

    expect(zshrc).not.toContain("/old/path/metamux");
    expect(count(zshrc, "# >>> metamux >>>")).toBe(1);
  });
});
