#!/bin/sh
# Install the pre-commit hook. Run once after cloning.
set -e

mkdir -p .git/hooks
cp scripts/pre-commit.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit scripts/secret-scan.mjs scripts/init-db.sh

echo "pre-commit hook installed"
echo "verify with: node scripts/secret-scan.mjs"
