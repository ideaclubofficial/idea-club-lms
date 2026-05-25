#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX_FILE="$ROOT_DIR/index.html"

if ! grep -q "const ENABLE_PAYMENT_SLIP_OCR = false;" "$INDEX_FILE"; then
  echo "FAIL: ENABLE_PAYMENT_SLIP_OCR is not false"
  exit 1
fi

guard_line="$(grep -n "if (!ENABLE_PAYMENT_SLIP_OCR)" "$INDEX_FILE" | head -n 1 | cut -d: -f1 || true)"
call_line="$(grep -n "httpsCallable('uploadPaymentSlipToDriveAndOcr')" "$INDEX_FILE" | head -n 1 | cut -d: -f1 || true)"

if [[ -z "$guard_line" || -z "$call_line" ]]; then
  echo "FAIL: OCR guard or callable reference was not found"
  exit 1
fi

if (( guard_line >= call_line )); then
  echo "FAIL: OCR callable appears before the pause guard"
  exit 1
fi

echo "OK: OCR upload is paused and callable is behind the guard"
