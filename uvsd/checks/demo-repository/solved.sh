#!/bin/sh
# demo-repository is a Git workshop: conflict-demo/hello.c is broken on
# purpose, so its CI fails until a student fixes it. This applies the
# exercise's answer to a temporary copy and runs the repository's own two
# workflows (code-format.yml, compile.yml) on it. Run from the repository.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
mkdir -p "$t/conflict-demo"
cp .clang-format "$t/"
cp conflict-demo/hello.c "$t/conflict-demo/"
patch -s -d "$t" -p1 < "$here/solution.patch"
cd "$t"
clang-format conflict-demo/hello.c --style=file --Werror -n
cc -o hello conflict-demo/hello.c
out=$(./hello)
[ "$out" = "Hello, world!" ] || { echo "expected 'Hello, world!', got '$out'"; exit 1; }
echo "solved exercise passes code-format.yml and compile.yml"
