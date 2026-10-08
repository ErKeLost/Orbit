function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")
  const binary = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = ""
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

const SESSION_ID_LENGTH = 16
const SEQ_LENGTH = 8
const NONCE_LENGTH = 12

function writeSeq(dst: Uint8Array, offset: number, seq: number): void {
  const hi = Math.floor(seq / 0x100000000)
  const lo = seq >>> 0
  dst[offset] = (hi >>> 24) & 0xff
  dst[offset + 1] = (hi >>> 16) & 0xff
  dst[offset + 2] = (hi >>> 8) & 0xff
  dst[offset + 3] = hi & 0xff
  dst[offset + 4] = (lo >>> 24) & 0xff
  dst[offset + 5] = (lo >>> 16) & 0xff
  dst[offset + 6] = (lo >>> 8) & 0xff
  dst[offset + 7] = lo & 0xff
}

function readSeq(src: Uint8Array, offset: number): number {
  let hi = 0
  let lo = 0
  for (let index = 0; index < 4; index += 1) hi = hi * 256 + src[offset + index]
  for (let index = 4; index < 8; index += 1) lo = lo * 256 + src[offset + index]
  return hi * 0x100000000 + lo
}

async function encryptionKey(value: string): Promise<CryptoKey> {
  const raw = decodeBase64Url(value)
  if (raw.length !== 32) throw new Error("Orbit Relay 加密密钥无效")
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
}

function frameAad(sessionId: Uint8Array, seq: number): Uint8Array<ArrayBuffer> {
  const value = new Uint8Array(SESSION_ID_LENGTH + SEQ_LENGTH)
  value.set(sessionId, 0)
  writeSeq(value, SESSION_ID_LENGTH, seq)
  return value
}

/** A random per-connection session id. It is part of every frame's GCM AAD, so
 * a frame captured on one connection can never be replayed onto another. */
export function newSessionId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SESSION_ID_LENGTH))
}

/** The sequence number reserved for the auth frame (first frame of a session). */
export const AUTH_SEQ = 0

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index]
  return diff === 0
}

export async function encryptRemoteFrame(
  value: string,
  key: string,
  sessionId: Uint8Array,
  seq: number,
): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH))
  const plaintext = new TextEncoder().encode(value)
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: frameAad(sessionId, seq) },
    await encryptionKey(key),
    plaintext,
  ))
  const frame = new Uint8Array(SESSION_ID_LENGTH + SEQ_LENGTH + NONCE_LENGTH + ciphertext.length)
  frame.set(sessionId, 0)
  writeSeq(frame, SESSION_ID_LENGTH, seq)
  frame.set(nonce, SESSION_ID_LENGTH + SEQ_LENGTH)
  frame.set(ciphertext, SESSION_ID_LENGTH + SEQ_LENGTH + NONCE_LENGTH)
  return encodeBase64Url(frame)
}

export type DecryptedRemoteFrame = { plaintext: string; sessionId: Uint8Array; seq: number }

export async function decryptRemoteFrame(value: string, key: string): Promise<DecryptedRemoteFrame> {
  const frame = decodeBase64Url(value)
  if (frame.length < SESSION_ID_LENGTH + SEQ_LENGTH + NONCE_LENGTH + 16) {
    throw new Error("Orbit Relay 加密帧无效")
  }
  const sessionId = frame.slice(0, SESSION_ID_LENGTH)
  const seq = readSeq(frame, SESSION_ID_LENGTH)
  const nonce = frame.slice(SESSION_ID_LENGTH + SEQ_LENGTH, SESSION_ID_LENGTH + SEQ_LENGTH + NONCE_LENGTH)
  const ciphertext = frame.slice(SESSION_ID_LENGTH + SEQ_LENGTH + NONCE_LENGTH)
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: frameAad(sessionId, seq) },
    await encryptionKey(key),
    ciphertext,
  )
  return { plaintext: new TextDecoder().decode(plaintext), sessionId, seq }
}
