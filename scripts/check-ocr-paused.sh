#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX_FILE="$ROOT_DIR/index.html"

if ! grep -q "const ENABLE_PAYMENT_SLIP_OCR = false;" "$INDEX_FILE"; then
  echo "FAIL: ENABLE_PAYMENT_SLIP_OCR is not false"
  exit 1
fi

if grep -q "httpsCallable('uploadPaymentSlipToDriveAndOcr')" "$INDEX_FILE"; then
  echo "FAIL: OCR callable is still reachable from index.html"
  exit 1
fi

if grep -q "upload slip OCR error" "$INDEX_FILE"; then
  echo "FAIL: OCR upload error path is still present in index.html"
  exit 1
fi

echo "OK: OCR upload is paused and no client OCR callable remains"
