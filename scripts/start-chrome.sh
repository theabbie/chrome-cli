#!/bin/bash

DEBUG_PROFILE="$HOME/.chrome-cli/debug-profile"
mkdir -p "$DEBUG_PROFILE"

case "$(uname -s)" in
  Darwin)
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      --remote-debugging-port=9222 \
      --user-data-dir="$DEBUG_PROFILE" \
      "$@"
    ;;
  Linux)
    google-chrome \
      --remote-debugging-port=9222 \
      --user-data-dir="$DEBUG_PROFILE" \
      "$@"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    "/c/Program Files/Google/Chrome/Application/chrome.exe" \
      --remote-debugging-port=9222 \
      --user-data-dir="$DEBUG_PROFILE" \
      "$@"
    ;;
esac
