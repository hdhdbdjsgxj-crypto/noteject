#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

[[ "$(uname -s)" == Darwin && "${GITHUB_ACTIONS:-}" == true ]] || {
  echo 'Run this signing script on the hosted macOS runner.' >&2
  exit 1
}
: "${IOS_CERTIFICATE_P12:?Set IOS_CERTIFICATE_P12 in GitHub Actions secrets}"
: "${IOS_CERTIFICATE_PASSWORD:?Set IOS_CERTIFICATE_PASSWORD in GitHub Actions secrets}"
: "${IOS_PROVISIONING_PROFILE:?Set IOS_PROVISIONING_PROFILE in GitHub Actions secrets}"
umask 077
work="$(mktemp -d "${RUNNER_TEMP:?}/noteject-ios.XXXXXXXX")"
keychain="$work/signing.keychain-db"
installed_profile=''
cleanup() {
  if [[ -n "$installed_profile" ]]; then rm -f "$installed_profile"; fi
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

printf '%s' "$IOS_CERTIFICATE_P12" | base64 -D > "$work/signing.p12"
printf '%s' "$IOS_PROVISIONING_PROFILE" | base64 -D > "$work/signing.mobileprovision"
unset IOS_CERTIFICATE_P12 IOS_PROVISIONING_PROFILE

security cms -D -i "$work/signing.mobileprovision" > "$work/profile.plist"
bundle_id='com.noteject.app'
team="$(/usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "$work/profile.plist")"
profile="$(/usr/libexec/PlistBuddy -c 'Print :UUID' "$work/profile.plist")"
profile_name="$(/usr/libexec/PlistBuddy -c 'Print :Name' "$work/profile.plist")"
identifier="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' "$work/profile.plist")"
if [[ "$identifier" != *."$bundle_id" ]] ||
   ! /usr/libexec/PlistBuddy -c 'Print :ProvisionedDevices:0' "$work/profile.plist" >/dev/null 2>&1 ||
   [[ "$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:get-task-allow' "$work/profile.plist")" != false ]]; then
  echo "Provide an Apple Ad Hoc profile for $bundle_id with at least one registered device." >&2
  exit 1
fi

profile_directory="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
mkdir -p "$profile_directory"
if [[ ! -e "$profile_directory/$profile.mobileprovision" ]]; then
  installed_profile="$profile_directory/$profile.mobileprovision"
  cp "$work/signing.mobileprovision" "$installed_profile"
fi

keychain_password="$(openssl rand -hex 24)"
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security list-keychains -d user -s "$keychain"
security import "$work/signing.p12" -P "$IOS_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -t agg -f pkcs12 -k "$keychain"
unset IOS_CERTIFICATE_PASSWORD
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain"

version="$(node -p "require('./package.json').version")"
build_number="${GITHUB_RUN_NUMBER:?}"
xcrun swift apple/prepare-ios-icon.swift noteject-logo.png \
  ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
xcodebuild archive -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$work/Noteject.xcarchive" \
  "DEVELOPMENT_TEAM=$team" CODE_SIGN_STYLE=Manual "CODE_SIGN_IDENTITY=Apple Distribution" \
  "NOTEJECT_IOS_PROFILE=$profile_name" "MARKETING_VERSION=$version" "CURRENT_PROJECT_VERSION=$build_number"

plutil -create xml1 "$work/ExportOptions.plist"
plutil -insert method -string release-testing "$work/ExportOptions.plist"
plutil -insert destination -string export "$work/ExportOptions.plist"
plutil -insert signingStyle -string manual "$work/ExportOptions.plist"
plutil -insert signingCertificate -string 'Apple Distribution' "$work/ExportOptions.plist"
plutil -insert teamID -string "$team" "$work/ExportOptions.plist"
/usr/libexec/PlistBuddy -c 'Add :provisioningProfiles dict' \
  -c "Add :provisioningProfiles:$bundle_id string $profile" "$work/ExportOptions.plist"
xcodebuild -exportArchive -archivePath "$work/Noteject.xcarchive" \
  -exportOptionsPlist "$work/ExportOptions.plist" -exportPath "$work/export"

set -- "$work/export/"*.ipa
[[ "$#" -eq 1 && -f "$1" ]] || { echo 'Expected a single signed IPA.' >&2; exit 1; }
ditto -x -k "$1" "$work/verify"
codesign --verify --deep --strict "$work/verify/Payload/App.app"
[[ -f "$work/verify/Payload/App.app/embedded.mobileprovision" ]]
mkdir -p release/apple
cp "$1" "release/apple/Noteject-iPhone-iPad-$version.ipa"
