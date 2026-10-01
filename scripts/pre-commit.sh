#!/bin/sh
# Pre-commit hook. Installed by scripts/install-hooks.sh
#
# Blocks the commit before the object is created, so a rejected secret never
# reaches the git object database.

set -e

node scripts/secret-scan.mjs
