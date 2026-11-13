import fs from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';

// Verify ad hoc CodeDirectory hashes without relying on a CMS certificate.
// Apple-issued distribution signatures are verified by the macOS build path.
export async function verifyAdHocSignature(executable, infoPlist, codeResources) {
  const bytes = await fs.readFile(executable);
  if (bytes.readUInt32LE(0) !== 0xfeedfacf) throw new Error('Expected a 64-bit Mach-O executable.');
  let command = 32;
  let signatureOffset;
  let signatureLength;
  for (let index = 0; index < bytes.readUInt32LE(16); index++) {
    const size = bytes.readUInt32LE(command + 4);
    if (size < 8 || command + size > bytes.length) throw new Error('Invalid Mach-O load command.');
    if (bytes.readUInt32LE(command) === 0x1d) {
      signatureOffset = bytes.readUInt32LE(command + 8);
      signatureLength = bytes.readUInt32LE(command + 12);
    }
    command += size;
  }
  if (!signatureOffset || signatureOffset + signatureLength > bytes.length) {
    throw new Error('The Mach-O signature is missing or out of bounds.');
  }
  const signature = bytes.subarray(signatureOffset, signatureOffset + signatureLength);
  if (signature.readUInt32BE(0) !== 0xfade0cc0 || signature.readUInt32BE(4) > signature.length) {
    throw new Error('Invalid embedded signature.');
  }
  const blobs = new Map();
  for (let index = 0; index < signature.readUInt32BE(8); index++) {
    const slot = 12 + index * 8;
    const offset = signature.readUInt32BE(slot + 4);
    const length = signature.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > signature.length) throw new Error('Invalid signature blob.');
    blobs.set(signature.readUInt32BE(slot), signature.subarray(offset, offset + length));
  }
  const directory = blobs.get(0);
  if (!directory || directory.readUInt32BE(0) !== 0xfade0c02 ||
      !(directory.readUInt32BE(12) & 2)) throw new Error('Expected an ad hoc CodeDirectory.');
  const hashOffset = directory.readUInt32BE(16);
  const specialSlots = directory.readUInt32BE(24);
  const codeSlots = directory.readUInt32BE(28);
  const codeLimit = directory.readUInt32BE(32);
  const hashSize = directory[36];
  if (directory[37] !== 2 || hashSize !== 32) throw new Error('Expected SHA-256 code hashes.');
  const pageSize = 2 ** directory[39];
  if (codeLimit > signatureOffset || Math.ceil(codeLimit / pageSize) !== codeSlots ||
      hashOffset - specialSlots * hashSize < 0 ||
      hashOffset + codeSlots * hashSize > directory.length) {
    throw new Error('Invalid CodeDirectory hash ranges.');
  }
  const verifyHash = (data, offset) => {
    const actual = createHash('sha256').update(data).digest();
    if (!timingSafeEqual(actual, directory.subarray(offset, offset + hashSize))) {
      throw new Error('A Mach-O code or resource hash does not match its signature.');
    }
  };
  for (let index = 0; index < codeSlots; index++) {
    verifyHash(bytes.subarray(index * pageSize, Math.min((index + 1) * pageSize, codeLimit)),
      hashOffset + index * hashSize);
  }
  const external = new Map([
    [1, await fs.readFile(infoPlist)], [3, await fs.readFile(codeResources)]
  ]);
  for (let slot = 1; slot <= specialSlots; slot++) {
    const offset = hashOffset - slot * hashSize;
    const hash = directory.subarray(offset, offset + hashSize);
    if (hash.every(byte => byte === 0)) {
      if (external.has(slot)) throw new Error('A required resource is absent from the signature.');
      continue;
    }
    const content = external.get(slot) || blobs.get(slot);
    if (!content) throw new Error(`Missing signed content for special slot ${slot}.`);
    verifyHash(content, offset);
  }
  if (specialSlots < 3) throw new Error('The signature does not bind its Info.plist and resource seal.');
  console.log(`Verified ${codeSlots} Mach-O pages and ${specialSlots} special signature slots.`);
}
