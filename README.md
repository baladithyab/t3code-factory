# T3 Factory

T3 Factory (`t3factory`) is a fork of [T3 Code](https://github.com/pingdotgg/t3code) for
project-scoped issue and feed intake, scheduled agent prompts, and an explicit project orchestrator.
It retains T3 Code's provider-backed threads and web, Electron desktop, and native mobile clients.
Upstream T3 Code is developed by T3 Tools; its attribution and license remain unchanged.

Open **Factory** for Overview, Issues, Sources, Workflows, and Orchestrator. Use **Sessions** or
**New thread** for ordinary conversations. The [Factory guide](./docs/user/source-control.md#factory)
explains scope selection, reviewed issue and feed-item starts, orchestrator orientation, and
workflow dispatch limits.

Fork work is tracked in [this repository's issues](https://github.com/baladithyab/t3code-factory/issues),
including [the Factory UX specification](https://github.com/baladithyab/t3code-factory/issues/29).
Inspiration sources, research, and parity evidence remain in
[the source register](https://github.com/baladithyab/t3code-factory/issues/1),
[research](https://github.com/baladithyab/t3code-factory/issues/27), and
[the design decision](https://github.com/baladithyab/t3code-factory/issues/28).
Those references do not imply feature parity or source reuse.

The [T3 Factory vision](./docs/factory/vision.md) describes a shared thread-first experience
for software, research, and knowledge work, with editable SVG, Mermaid, and draw.io diagrams.
It distinguishes existing capabilities from proposed orchestration and sandbox extensions.

## Upstream installation

The commands and releases below install upstream T3 Code, not this fork.
To work on this fork, use the source setup below and the
[development guide](./docs/operations/development.md).

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

### Command line

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

Then run `t3` to start the server and open the local web app. `t3 service install` keeps it running in the background, `t3 update` moves to a newer release, and `t3 --help` has the full reference.

To try it once without installing, run `npx t3@latest` instead.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### Windows (`scoop`)

```bash
scoop install extras/t3code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Debian, Ubuntu (`.deb`)

Download the `.deb` from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), then:

```bash
sudo apt install ./T3-Code-*.deb
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

#### Nix (nixpkgs)

```bash
nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code
```

The package is maintained in [nixpkgs](https://github.com/NixOS/nixpkgs/tree/nixos-unstable/pkgs/by-name/t3/t3code)
and includes the desktop app (`t3code-desktop`) and the `t3` command.
See [Nix installation](./docs/user/install.md#nix-nixpkgs) for NixOS configuration and updates.

## Some notes

This fork's issue tracker records Factory work. The upstream project has its own contribution
policy; read [CONTRIBUTING.md](./CONTRIBUTING.md) before proposing an upstream change.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [FAQ](./docs/user/faq.md)
- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Factory and source control](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## Source setup and upstream support

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

For upstream feature requests, start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

For upstream support, join the [Discord](https://discord.gg/jn4EGJjrvv).
