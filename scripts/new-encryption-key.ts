/** Prints a new random 256-bit key (64 hexadecimal characters) for ENCRYPTION_KEY. Nothing is stored. */
import { randomBytes } from 'crypto';

console.log(randomBytes(32).toString('hex'));
