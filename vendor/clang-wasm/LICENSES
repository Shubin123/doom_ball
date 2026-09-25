# Licences of the shipped components

The published package combines several projects' work, so no single licence describes it.
`package.json` says `SEE LICENSE IN LICENSES` and points here.

## What is in the package

**The compiler.** `gen/llvm.core.wasm`, plus three small jco adapter modules, is Clang, LLD and the
LLVM binutils compiled to WebAssembly from [`arm/arm-toolchain`](https://github.com/arm/arm-toolchain)
at an Arm Toolchain for Embedded release tag. LLVM is Apache-2.0 **with** LLVM-exception.

**The libraries and headers.** `gen/llvm-resources.tar` holds the sysroot: newlib-nano, libc++,
libc++abi, compiler-rt and `crt0.o`, taken from the same ATfE release. libc++ and compiler-rt are
Apache-2.0 **with** LLVM-exception. newlib carries its own collection of BSD-style notices, 57 of
them in Arm's `COPYING.NEWLIB`. Arm's notice files travel with the libraries, under
`share/licenses/` inside that tar.

**The Clang builtin headers**, under `lib/clang/<version>/include`, come from the same LLVM build and
carry the same licence as the compiler.

**The JavaScript.** `gen/bundle.js` and `lib/api.d.ts` derive from
[YoWASP/clang](https://codeberg.org/YoWASP/clang) by Catherine (whitequark), with our changes, and
bundle [`@yowasp/runtime`](https://www.npmjs.com/package/@yowasp/runtime) by the same author. Both
are ISC, as their `package.json` files declare. The `LICENSE.txt` beside this file is the Apache-2.0
text upstream ships for the LLVM parts, not the terms of that JavaScript.

**The patches** in `patches/*/*.patch` are a commit from YoWASP's LLVM fork, so LLVM code under
Apache-2.0 with LLVM-exception.
