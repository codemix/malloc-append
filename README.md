# malloc-append
An append-only memory allocator with the same interface as [malloc](https://github.com/codemix/malloc), useful for implementing append only logs. Has no `free()` but does not enforce write-once.

[![Build Status](https://travis-ci.org/codemix/malloc-append.svg?branch=master)](https://travis-ci.org/codemix/malloc-append)

## What?

It lets you allocate a large, contiguous slab of memory up front and then `alloc()` within that buffer.

It is mostly useful in conjunction with things like [mmap.js](https://github.com/indutny/mmap.js).

It's developed using [design by contract](https://github.com/codemix/babel-plugin-contracts), so you might find the library's own code style a bit unusual, but it doesn't affect usage or performance.

## Installation

Install via [npm](https://npmjs.org/package/malloc-append).

## Usage

```js
import Allocator from "malloc-append";

const heap = new Buffer(1024 * 1024);
const allocator = new Allocator(heap); // heap could also be an ArrayBuffer
console.log(allocator.inspect());

let firstAddress = 0;
let lastAddress = 0;

for (let i = 0; i < 100; i++) {
  const address = allocator.alloc(64);
  if (firstAddress === 0) {
    firstAddress = address;
  }
  if (lastAddress !== 0) {
    // do something with the address
    heap.writeUInt32LE(address, lastAddress);
  }
}

let address = firstAddress;
for (let i = 0; i < 100; i++) {
  console.log('Reading address', address);
  address = heap.readUInt32LE(address);
}

```


## License

Published by [codemix](http://codemix.com/) under a permissive MIT License, see [LICENSE.md](./LICENSE.md).
