#!/bin/bash
source "$(dirname "$0")/common.sh"
exec "$NODE_BINARY" "$SCRIPT_DIR/manage.cjs" stop
