#!/bin/sh
set -eu
# Pinned official musl releases; no installer scripts or ambient Radicle identity are executed.
# Checksums: https://files.radicle.dev/releases/1.10.3/
case "$1" in
  amd64) platform=x86_64; digest=3d78e3ffc17f9e6eca7fcd3acc439f2252060532eb457cf17f2747fed4cc6751 ;;
  arm64) platform=aarch64; digest=822c1ea1da7dd3a2a7f98da6d93b95359b5b9b0e302b8535bea377a2441e596f ;;
  *) printf '%s\n' 'Unsupported Radicle build architecture' >&2; exit 1 ;;
esac
archive="radicle-1.10.3-${platform}-unknown-linux-musl.tar.xz"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-time 120 \
  "https://files.radicle.dev/releases/1.10.3/$archive" -o "$scratch/$archive"
printf '%s  %s\n' "$digest" "$scratch/$archive" | sha256sum -c -
mkdir -p "$2"
tar -xJf "$scratch/$archive" --strip-components=1 -C "$2"
test -x "$2/bin/rad"
test -x "$2/bin/radicle-node"
test -x "$2/bin/git-remote-rad"
