#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <artifact-root> <repository> <tag> <output>" >&2
  exit 2
fi

artifact_root=$1
repository=$2
tag=$3
output=$4
version=${tag#v}

find_one() {
  local pattern=$1
  local result
  result=$(find "$artifact_root" -type f -name "$pattern" -print -quit)
  if [ -z "$result" ]; then
    echo "missing updater artifact matching $pattern" >&2
    exit 1
  fi
  printf '%s' "$result"
}

linux_appimage_bundle=$(find_one '*.AppImage')
linux_deb_bundle=$(find_one '*.deb')
macos_bundle=$(find_one '*.app.tar.gz')
windows_nsis_bundle=$(find_one '*-setup.exe')
windows_msi_bundle=$(find_one '*.msi')

for bundle in \
  "$linux_appimage_bundle" \
  "$linux_deb_bundle" \
  "$macos_bundle" \
  "$windows_nsis_bundle" \
  "$windows_msi_bundle"; do
  if [ ! -s "$bundle.sig" ]; then
    echo "missing signature for $bundle" >&2
    exit 1
  fi
done

asset_url() {
  printf 'https://github.com/%s/releases/download/%s/%s' \
    "$repository" "$tag" "$(basename "$1")"
}

jq -n \
  --arg version "$version" \
  --arg pub_date "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
  --arg linux_appimage_url "$(asset_url "$linux_appimage_bundle")" \
  --arg linux_appimage_signature "$(tr -d '\r\n' < "$linux_appimage_bundle.sig")" \
  --arg linux_deb_url "$(asset_url "$linux_deb_bundle")" \
  --arg linux_deb_signature "$(tr -d '\r\n' < "$linux_deb_bundle.sig")" \
  --arg macos_url "$(asset_url "$macos_bundle")" \
  --arg macos_signature "$(tr -d '\r\n' < "$macos_bundle.sig")" \
  --arg windows_nsis_url "$(asset_url "$windows_nsis_bundle")" \
  --arg windows_nsis_signature "$(tr -d '\r\n' < "$windows_nsis_bundle.sig")" \
  --arg windows_msi_url "$(asset_url "$windows_msi_bundle")" \
  --arg windows_msi_signature "$(tr -d '\r\n' < "$windows_msi_bundle.sig")" \
  '{
    version: $version,
    notes: "Signed automatic update",
    pub_date: $pub_date,
    platforms: {
      "linux-x86_64": {
        url: $linux_appimage_url,
        signature: $linux_appimage_signature
      },
      "linux-x86_64-appimage": {
        url: $linux_appimage_url,
        signature: $linux_appimage_signature
      },
      "linux-x86_64-deb": {
        url: $linux_deb_url,
        signature: $linux_deb_signature
      },
      "darwin-aarch64": {
        url: $macos_url,
        signature: $macos_signature
      },
      "darwin-aarch64-app": {
        url: $macos_url,
        signature: $macos_signature
      },
      "windows-x86_64": {
        url: $windows_nsis_url,
        signature: $windows_nsis_signature
      },
      "windows-x86_64-nsis": {
        url: $windows_nsis_url,
        signature: $windows_nsis_signature
      },
      "windows-x86_64-msi": {
        url: $windows_msi_url,
        signature: $windows_msi_signature
      }
    }
  }' > "$output"
