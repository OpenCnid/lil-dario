# Mac Install Guide for OpenCnid/lil-dario

This installs the OpenCnid fork of Dario on macOS instead of the upstream npm package.

The fork still exposes the same CLI binary name, `dario`, but includes OpenClaw-friendly changes such as the validated `openclaw-wide-alias` preserve-tools profile.

## Prerequisites

Install Homebrew first if you do not already have it:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Then install the required tools:

```bash
brew install git node
```

Recommended for Claude Code / Dario fingerprint fidelity:

```bash
brew install oven-sh/bun/bun
```

## Remove the upstream Dario package

If regular Dario was installed from npm, remove it first so the global `dario` command points at this fork:

```bash
npm uninstall -g @askalf/dario
```

## Install the OpenCnid fork

```bash
mkdir -p ~/src
git clone https://github.com/OpenCnid/lil-dario.git ~/src/lil-dario
cd ~/src/lil-dario
npm ci
npm run build
npm install -g .
```

## Verify the install

```bash
which dario
dario --version
dario doctor
```

`which dario` should point to your global npm binary location, and `dario --version` should print the fork's package version.

## Log in and run for OpenClaw

```bash
dario login
dario proxy --preserve-tools --preserve-tools-profile=openclaw-wide-alias
```

For OpenClaw or tools using Anthropic/OpenAI-compatible environment variables:

```bash
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario
export OPENAI_BASE_URL=http://localhost:3456/v1
export OPENAI_API_KEY=dario
```

## Updating later

```bash
cd ~/src/lil-dario
git pull
npm ci
npm run build
npm install -g .
```

## Why not install directly from GitHub with npm?

Avoid this for now:

```bash
npm install -g github:OpenCnid/lil-dario
```

The repository does not currently commit `dist/`, and the package does not run a build during direct GitHub installation. Installing from a cloned checkout and running `npm run build` first guarantees the `dario` binary has the compiled files it needs.

## Troubleshooting

### `dario: command not found`

Check where npm global binaries are installed:

```bash
npm bin -g
```

Make sure that directory is in your `PATH`.

### `dario doctor` warns about TLS/runtime

Install Bun and try again:

```bash
brew install oven-sh/bun/bun
dario doctor
```

### You still seem to be running upstream Dario

Reinstall from the fork checkout:

```bash
npm uninstall -g @askalf/dario
cd ~/src/lil-dario
npm run build
npm install -g .
which dario
dario --version
```
