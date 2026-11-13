#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != Darwin ]] || ! command -v xcodebuild >/dev/null; then
  echo 'A native iOS build requires a macOS machine with Xcode. No IPA was created.' >&2
  exit 1
fi
xcrun --sdk iphoneos --show-sdk-path >/dev/null
version="$(node -p "require('./package.json').version")"
build_number="${GITHUB_RUN_NUMBER:-1}"
[[ "$build_number" =~ ^[0-9]+$ ]] || { echo 'The build number must be numeric.' >&2; exit 1; }
work="$(mktemp -d "${TMPDIR:-/tmp}/noteject-ios-unsigned.XXXXXXXX")"
trap 'rm -rf "$work"' EXIT

xcrun swift apple/prepare-ios-icon.swift noteject-logo.png \
  ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
xcodebuild build -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath "$work/DerivedData" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY='' \
  'TARGETED_DEVICE_FAMILY=1,2' ARCHS=arm64 ONLY_ACTIVE_ARCH=NO \
  "MARKETING_VERSION=$version" "CURRENT_PROJECT_VERSION=$build_number"

app="$work/DerivedData/Build/Products/Release-iphoneos/App.app"
[[ -d "$app" ]] || { echo 'Xcode did not produce the device app. No IPA was created.' >&2; exit 1; }
plist="$app/Info.plist"
executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist")"
[[ "$executable" != */* && -f "$app/$executable" ]] || { echo 'Missing compiled app executable.' >&2; exit 1; }
[[ "$(/usr/libexec/PlistBuddy -c 'Print :DTPlatformName' "$plist")" == iphoneos ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")" == com.noteject.app ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :UIDeviceFamily:0' "$plist")" == 1 ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :UIDeviceFamily:1' "$plist")" == 2 ]]
architectures="$(xcrun lipo -archs "$app/$executable")"
[[ " $architectures " == *' arm64 '* ]] || { echo 'Expected a compiled arm64 device executable.' >&2; exit 1; }
[[ -f "$app/public/index.html" && -f "$app/capacitor.config.json" ]]

mkdir -p "$work/Payload" release/apple
ditto "$app" "$work/Payload/App.app"
ipa="release/apple/Noteject-iPhone-iPad-$version-unsigned.ipa"
ditto -c -k --keepParent "$work/Payload" "$ipa"
unzip -tq "$ipa"
export NOTEJECT_IPA_PATH="$ipa" NOTEJECT_IPA_VERSION="$version" NOTEJECT_IPA_BUILD="$build_number"
node --input-type=module <<'JS'
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const file = process.env.NOTEJECT_IPA_PATH;
const hash = createHash('sha256');
for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
const report = {
  file, version: process.env.NOTEJECT_IPA_VERSION, build: process.env.NOTEJECT_IPA_BUILD,
  platform: 'iphoneos', architectures: ['arm64'], devices: ['iPhone', 'iPad'],
  signedForInstallation: false, bytes: fs.statSync(file).size, sha256: hash.digest('hex'),
  installation: 'Requires Apple signing and provisioning before installation on ordinary devices.'
};
fs.writeFileSync(file.replace(/\.ipa$/, '.json'), JSON.stringify(report, null, 2) + '\n');
console.log('Compiled unsigned device IPA: ' + file);
console.log(report.installation);
JS
