// MIME helpers for the Gmail SMTP sender. Output is pure ASCII so no 8-bit handling by relays can corrupt it.

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

// RFC 2047 encoded-words (UTF-8, base64). Plain printable ASCII is passed through unchanged.
// Each word stays well under the 75-character limit and never splits a UTF-8 character.
export function encodeSubject(subject: string): string {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject
  const encoder = new TextEncoder()
  const words: string[] = []
  let chunk = ''
  let chunkBytes = 0
  for (const char of subject) {
    const size = encoder.encode(char).length
    if (chunkBytes + size > 45) {
      words.push(`=?UTF-8?B?${toBase64(encoder.encode(chunk))}?=`)
      chunk = ''
      chunkBytes = 0
    }
    chunk += char
    chunkBytes += size
  }
  if (chunk) words.push(`=?UTF-8?B?${toBase64(encoder.encode(chunk))}?=`)
  return words.join('\r\n ')
}

// Base64 body wrapped at 76 characters, for Content-Transfer-Encoding: base64.
export function encodeBodyBase64(text: string): string {
  const encoded = toBase64(new TextEncoder().encode(text))
  return encoded.match(/.{1,76}/g)?.join('\r\n') ?? ''
}
