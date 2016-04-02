/* @flow */

const HEADER_SIZE_IN_QUADS = 1 + 64; // For compatibility with malloc.
const HEADER_OFFSET_IN_QUADS = 1;
const TRAILER_POINTER_OFFSET_IN_QUADS = HEADER_OFFSET_IN_QUADS + 1;

const POINTER_SIZE_IN_QUADS = 1;
const POINTER_OVERHEAD_IN_QUADS = 2;

const MIN_FREEABLE_SIZE_IN_QUADS = 3;
const FIRST_BLOCK_OFFSET_IN_QUADS = HEADER_OFFSET_IN_QUADS + HEADER_SIZE_IN_QUADS + POINTER_OVERHEAD_IN_QUADS;

const MIN_FREEABLE_SIZE_IN_BYTES = 16;
const FIRST_BLOCK_OFFSET_IN_BYTES = FIRST_BLOCK_OFFSET_IN_QUADS * 4;
const OVERHEAD_IN_BYTES = (FIRST_BLOCK_OFFSET_IN_QUADS + 1) * 4;

const ALIGNMENT_IN_BYTES = 8;
const ALIGNMENT_MASK = ALIGNMENT_IN_BYTES - 1;

type ListNode = {
  type: string;
  offset: int32;
  size: int32;
  height: int32;
  pointers: int32[];
};

type InspectionResult = {
  header: ListNode;
  blocks: Array<{
    type: string;
    size: int32;
    node?: ListNode
  }>;
};

export default class Allocator {

  buffer: ArrayBuffer;
  byteOffset: uint32;
  byteLength: uint32;
  int32Array: Int32Array;

  /**
   * Initialize the allocator from the given Buffer or ArrayBuffer.
   */
  constructor (buffer: Buffer|ArrayBuffer, byteOffset: uint32 = 0, byteLength: uint32 = 0) {
    pre: {
      if (buffer instanceof Buffer) {
        byteLength <= buffer.length;
      }
      else if (buffer instanceof ArrayBuffer) {
        byteLength <= buffer.byteLength;
      }
    }
    if (buffer instanceof Buffer) {
      this.buffer = buffer.buffer;
      this.byteOffset = buffer.byteOffset + byteOffset;
      this.byteLength = byteLength === 0 ? buffer.length : byteLength;
    }
    else if (buffer instanceof ArrayBuffer) {
      this.buffer = buffer;
      this.byteOffset = byteOffset;
      this.byteLength = byteLength === 0 ? buffer.byteLength - byteOffset : byteLength;
    }
    else {
      throw new TypeError(`Expected buffer to be an instance of Buffer or ArrayBuffer`);
    }
    assert: this.byteLength >= OVERHEAD_IN_BYTES;
    this.int32Array = prepare(new Int32Array(this.buffer, this.byteOffset, bytesToQuads(this.byteLength)));
    checkListIntegrity(this.int32Array);
  }

  /**
   * Allocate a given number of bytes and return the offset.
   * If allocation fails, returns 0.
   */
  alloc (numberOfBytes: int32): int32 {

    pre: checkListIntegrity(this.int32Array);

    post: {
      it === 0 || it >= quadsToBytes(FIRST_BLOCK_OFFSET_IN_QUADS);
      checkListIntegrity(this.int32Array);
    }

    numberOfBytes = align(numberOfBytes);

    if (numberOfBytes < MIN_FREEABLE_SIZE_IN_BYTES) {
      numberOfBytes = MIN_FREEABLE_SIZE_IN_BYTES;
    }
    else if (numberOfBytes > this.byteLength) {
      throw new RangeError(`Allocation size must be between ${MIN_FREEABLE_SIZE_IN_BYTES} bytes and ${this.byteLength - OVERHEAD_IN_BYTES} bytes`);
    }

    trace: `Allocating ${numberOfBytes} bytes.`;

    const minimumSize: int32 = bytesToQuads(numberOfBytes);
    const int32Array: Int32Array = this.int32Array;

    const block: int32 = int32Array[TRAILER_POINTER_OFFSET_IN_QUADS];
    trace: `Got block ${quadsToBytes(block)}`;
    if (block === HEADER_OFFSET_IN_QUADS) {
      trace: `Buffer is completely full.`;
      return 0;
    }
    const blockSize: int32 = int32Array.length - (block + POINTER_SIZE_IN_QUADS);

    if (block + minimumSize + POINTER_OVERHEAD_IN_QUADS >= int32Array.length) {
      trace: `Not enough space to allocate ${quadsToBytes(minimumSize)} bytes, got ${quadsToBytes(blockSize)}.`;
      return 0;
    }

    assert: readSize(int32Array, block) === blockSize;


    const remaining: uint32 = blockSize - (minimumSize + POINTER_SIZE_IN_QUADS);
    trace: `Remaining space after splitting: ${quadsToBytes(remaining)} bytes (of ${quadsToBytes(int32Array.length)})`;

    if (remaining >= MIN_FREEABLE_SIZE_IN_QUADS) {
      const second: int32 = block + minimumSize + POINTER_OVERHEAD_IN_QUADS;
      const secondSize: int32 = int32Array.length - (second + POINTER_SIZE_IN_QUADS);

      trace: `Splitting block ${quadsToBytes(block)} (${quadsToBytes(blockSize)} bytes) into ${quadsToBytes(minimumSize)} bytes and ${quadsToBytes(secondSize)} bytes, starting at ${quadsToBytes(second)}`;

      int32Array[block - 1] = -minimumSize;
      int32Array[block + minimumSize] = -minimumSize;

      int32Array[second - 1] = secondSize;
      int32Array[second + secondSize] = secondSize;
      int32Array[TRAILER_POINTER_OFFSET_IN_QUADS] = second;
    }
    else {
      trace: `Marking the buffer as completely full.`
      int32Array[block - 1] = -blockSize;
      int32Array[block + blockSize] = -blockSize;
      int32Array[TRAILER_POINTER_OFFSET_IN_QUADS] = HEADER_OFFSET_IN_QUADS;
    }

    return quadsToBytes(block);
  }

  /**
   * Allocate and clear the given number of bytes and return the offset.
   * If allocation fails, returns 0.
   */
  calloc (numberOfBytes: int32): int32 {
    post: {
      it === 0 || it >= quadsToBytes(FIRST_BLOCK_OFFSET_IN_QUADS);
      checkListIntegrity(this.int32Array);
    }

    if (numberOfBytes < MIN_FREEABLE_SIZE_IN_BYTES) {
      numberOfBytes = MIN_FREEABLE_SIZE_IN_BYTES;
    }
    else {
      numberOfBytes = align(numberOfBytes);
    }

    const address = this.alloc(numberOfBytes);
    if (address === 0) {
      // Not enough space
      return 0;
    }
    const int32Array = this.int32Array;
    const offset = bytesToQuads(address);
    const limit = numberOfBytes / 4;
    for (let i = 0; i < limit; i++) {
      int32Array[offset + i] = 0;
    }
    return address;
  }

  /**
   * Simulates freeing a number of bytes from the given address.
   * Always returns zero.
   */
  free (address: int32): int32 {

    pre: checkListIntegrity(this.int32Array);

    if ((address & ALIGNMENT_MASK) !== 0) {
      throw new RangeError(`Address must be a multiple of (${ALIGNMENT_IN_BYTES}).`);
    }

    if (address < FIRST_BLOCK_OFFSET_IN_BYTES || address > this.byteLength) {
      throw new RangeError(`Address must be between ${FIRST_BLOCK_OFFSET_IN_BYTES} and ${this.byteLength - OVERHEAD_IN_BYTES}`);
    }

    return 0; // Do nothing.
  }

  /**
   * Return the size of the block at the given address.
   */
  sizeOf (address: int32): uint32 {
    if (address < FIRST_BLOCK_OFFSET_IN_BYTES || address > this.byteLength || typeof address !== 'number' || isNaN(address)) {
      throw new RangeError(`Address must be between ${FIRST_BLOCK_OFFSET_IN_BYTES} and ${this.byteLength - OVERHEAD_IN_BYTES}`);
    }

    if ((address & ALIGNMENT_MASK) !== 0) {
      throw new RangeError(`Address must be a multiple of the pointer size (${4}).`);
    }

    return quadsToBytes(readSize(this.int32Array, bytesToQuads(address)));
  }

  /**
   * Inspect the instance.
   */
  inspect (): InspectionResult {
    return inspect(this.int32Array);
  }
}

/**
 * Prepare the given int32Array and ensure it contains a valid header.
 */
export function prepare (int32Array: Int32Array): Int32Array {
  if (!verifyHeader(int32Array)) {
    writeInitialHeader(int32Array);
  }
  return int32Array;
}

/**
 * Verify that the int32Array contains a valid header.
 */
export function verifyHeader (int32Array: Int32Array): boolean {
  return int32Array[HEADER_OFFSET_IN_QUADS - 1] === HEADER_SIZE_IN_QUADS
      && int32Array[HEADER_OFFSET_IN_QUADS + HEADER_SIZE_IN_QUADS] === HEADER_SIZE_IN_QUADS;
}

/**
 * Write the initial header for an empty int32Array.
 */
function writeInitialHeader (int32Array: Int32Array) {
  trace: `Writing initial header.`;
  const header = HEADER_OFFSET_IN_QUADS;
  const headerSize = HEADER_SIZE_IN_QUADS;
  const block = FIRST_BLOCK_OFFSET_IN_QUADS;
  const blockSize = int32Array.length - (header + headerSize + POINTER_OVERHEAD_IN_QUADS + POINTER_SIZE_IN_QUADS);

  writeFreeBlockSize(int32Array, headerSize, header);
  int32Array[TRAILER_POINTER_OFFSET_IN_QUADS] = block;

  writeFreeBlockSize(int32Array, blockSize, block);
}

/**
 * Check the integrity of the freelist in the given array.
 */
export function checkListIntegrity (int32Array: Int32Array): boolean {
  let block: int32 = FIRST_BLOCK_OFFSET_IN_QUADS;
  while (block < int32Array.length - POINTER_SIZE_IN_QUADS) {
    const size: int32 = readSize(int32Array, block);
    /* istanbul ignore if  */
    if (size < POINTER_OVERHEAD_IN_QUADS || size >= int32Array.length - FIRST_BLOCK_OFFSET_IN_QUADS) {
      throw new Error(`Got invalid sized chunk at ${quadsToBytes(block)} (${quadsToBytes(size)} bytes).`);
    }
    else if (isFree(int32Array, block)) {
      checkFreeBlockIntegrity(int32Array, block, size);
    }
    else {
      checkUsedBlockIntegrity(int32Array, block, size);
    }
    block += size + POINTER_OVERHEAD_IN_QUADS;
  }
  return true;
}

function checkFreeBlockIntegrity (int32Array: Int32Array, block: int32, blockSize: int32): boolean {
  /* istanbul ignore if  */
  if (int32Array[block - 1] !== int32Array[block + blockSize]) {
    throw new Error(`Block length header does not match footer (${quadsToBytes(int32Array[block - 1])} vs ${quadsToBytes(int32Array[block + blockSize])}).`);
  }
  /* istanbul ignore if  */
  else if (block + blockSize + POINTER_SIZE_IN_QUADS !== int32Array.length) {
    throw new Error(`Expected the free block to be the last block in the array ${block + blockSize + POINTER_SIZE_IN_QUADS} vs ${int32Array.length}`);
  }
  /* istanbul ignore if  */
  else if (int32Array[TRAILER_POINTER_OFFSET_IN_QUADS] !== block) {
    throw new Error(`Trailer does not point to free block. Expected ${block} got ${int32Array[TRAILER_POINTER_OFFSET_IN_QUADS]}.`);
  }
  else {
    return true;
  }
}

function checkUsedBlockIntegrity (int32Array: Int32Array, block: int32, blockSize: int32): boolean {
  /* istanbul ignore if  */
  if (int32Array[block - 1] !== int32Array[block + blockSize]) {
    throw new Error(`Block length header does not match footer (${quadsToBytes(int32Array[block - 1])} vs ${quadsToBytes(int32Array[block + blockSize])}).`);
  }
  else {
    return true;
  }
}


/**
 * Inspect the freelist in the given array.
 */
export function inspect (int32Array: Int32Array): InspectionResult {
  const blocks: {type: string; size: int32; node?: ListNode}[] = [];
  const header: ListNode = readListNode(int32Array, HEADER_OFFSET_IN_QUADS);
  let block: int32 = FIRST_BLOCK_OFFSET_IN_QUADS;
  while (block < int32Array.length - POINTER_SIZE_IN_QUADS) {
    const size: int32 = readSize(int32Array, block);
    /* istanbul ignore if  */
    if (size < POINTER_OVERHEAD_IN_QUADS || size >= int32Array.length) {
      throw new Error(`Got invalid sized chunk at ${quadsToBytes(block)} (${quadsToBytes(size)})`);
    }
    if (isFree(int32Array, block)) {
      // @flowIssue todo
      blocks.push(readListNode(int32Array, block));
    }
    else {
      blocks.push({
        type: 'used',
        offset: quadsToBytes(block),
        size: quadsToBytes(size)
      });
    }
    block += size + POINTER_OVERHEAD_IN_QUADS;
  }
  return {header, blocks};
}

/**
 * Convert quads to bytes.
 */
function quadsToBytes (num: int32): int32 {
  return num << 2;
}

/**
 * Convert bytes to quads.
 */
function bytesToQuads (num: int32): int32 {
  return num >> 2;
}

/**
 * Align the given value to 8 bytes.
 */
function align (value: int32): int32 {
  return (value + ALIGNMENT_MASK) & ~ALIGNMENT_MASK;
}

/**
 * Read the free list node for a given block.
 */
function readListNode (int32Array: Int32Array, block: int32): ListNode {
  pre: {
    block + MIN_FREEABLE_SIZE_IN_QUADS < int32Array.length;
  }

  return {
    type: 'free',
    offset: quadsToBytes(block),
    height: 0,
    pointers: [],
    size: quadsToBytes(int32Array[block - 1])
  };
}


/**
 * Read the size (in quads) of the block at the given address.
 */
function readSize (int32Array: Int32Array, block: int32): int32 {
  pre: {
    block >= 1;
    block < int32Array.length;
  }
  post: {
    it > 0;
    it <= int32Array.length;
    int32Array[block - 1] === int32Array[block + Math.abs(int32Array[block - 1])];
  }
  return Math.abs(int32Array[block - 1]);
}

/**
 * Write the size of the block at the given address.
 * Note: This ONLY works for free blocks, not blocks in use.
 */
function writeFreeBlockSize (int32Array: Int32Array, size: int32, block: int32): void {
  pre: {
    block >= 1;
    size !== 0;
  }
  post: {
    int32Array[block - 1] === size;
    int32Array[block + size] === size;
  }

  int32Array[block - 1] = size;
  int32Array[block + size] = size;
}


/**
 * Determine whether the block at the given address is free or not.
 */
function isFree (int32Array: Int32Array, block: int32): boolean {
  pre: {
    block < int32Array.length;
  }

  /* istanbul ignore if  */
  if (block < HEADER_SIZE_IN_QUADS) {
    return false;
  }

  const size: int32 = int32Array[block - POINTER_SIZE_IN_QUADS];

  assert: {
    size !== 0;
    if (size > 0) {
      size >= MIN_FREEABLE_SIZE_IN_QUADS;
      size < int32Array.length;
      int32Array[block + size] === size;
    }
    else {
      -size >= MIN_FREEABLE_SIZE_IN_QUADS;
      -size < int32Array.length;
      int32Array[block + -size] === size;
    }
  }

  if (size < 0) {
    return false;
  }
  else {
    return true;
  }
}

