#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Keep the application's private Rust source out of this public repository.
# The read-only token belongs in Render's environment, never in this repository.
relay_source_token="${LIRA_RELAY_SOURCE_TOKEN:-${GITHUB_RELEASES_TOKEN:-${GITHUB_REPORT_TOKEN:-${GITHUB_TOKEN:-}}}}"
if [ -z "$relay_source_token" ]; then
  echo 'Configure um token GitHub com Contents: Read para C1ean-dev/lira-clean.' >&2
  exit 1
fi
mkdir -p .build-tools/relay-source relay
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
  --header "Authorization: Bearer $relay_source_token" \
  --header 'Accept: application/vnd.github+json' \
  'https://api.github.com/repos/C1ean-dev/lira-clean/tarball/3a336ecafc3737641ba7bdd05c6c67dd721b462f' \
  -o .build-tools/relay-source.tar.gz
tar -xzf .build-tools/relay-source.tar.gz -C .build-tools/relay-source --strip-components=1
cp .build-tools/relay-source/Cargo.toml .build-tools/relay-source/Cargo.lock relay/
cp -R .build-tools/relay-source/src .build-tools/relay-source/ui relay/

export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export PATH="$CARGO_HOME/bin:$PATH"
if ! command -v rustup >/dev/null 2>&1; then
  mkdir -p .build-tools
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error https://sh.rustup.rs -o .build-tools/rustup-init.sh
  sh .build-tools/rustup-init.sh -y --profile minimal --default-toolchain 1.99.1
else
  rustup toolchain install 1.99.1 --profile minimal
fi
if ! command -v cmake >/dev/null 2>&1; then
  python3 -m pip install --disable-pip-version-check --target .build-tools cmake==3.31.6
  export PATH="$PWD/.build-tools/cmake/data/bin:$PATH"
fi
cargo +1.99.1 build --release --locked --manifest-path relay/Cargo.toml --bin lira-p2p-node
