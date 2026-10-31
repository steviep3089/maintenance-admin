export type SignedRequestVerifyOptions = {
  signingKey: string
  // Path included in the HMAC canonical string and sent by the signing caller.
  expectedPathAndQuery: string
  // Path exposed inside the function runtime; defaults to the signed path.
  expectedRuntimePathAndQuery?: string
  expectedMethod?: string
  nowSeconds?: number
  maxAgeSeconds?: number
  maxFutureSkewSeconds?: number
}

export type VerifiedSignedRequest = {
  requestId: string
  timestampSeconds: number
  bodyText: string
  bodySha256Hex: string
}

const DEFAULT_MAX_AGE_SECONDS = 5 * 60
const DEFAULT_MAX_FUTURE_SKEW_SECONDS = 30
const SIGNATURE_PREFIX = 'v1='

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

function fromHex(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) return null
    out[i] = byte
  }
  return out
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  return toHex(digest)
}

async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const keyBytes = new TextEncoder().encode(key)
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data)),
  )
  return toHex(sig)
}

function buildCanonicalString(args: {
  timestampSeconds: number
  requestId: string
  method: string
  pathAndQuery: string
  bodySha256Hex: string
}): string {
  const method = args.method.toUpperCase()
  return [
    'v1',
    String(args.timestampSeconds),
    args.requestId,
    method,
    args.pathAndQuery,
    args.bodySha256Hex,
  ].join('\n')
}

function parseTimestampSeconds(value: string | null): number | null {
  if (!value) return null
  if (!/^[0-9]{1,20}$/.test(value)) return null
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n <= 0) return null
  return n
}

function parseRequestId(value: string | null): string | null {
  if (!value) return null
  // Constrain length and characters to avoid log injection and weird parsing issues.
  if (value.length > 200) return null
  if (!/^[A-Za-z0-9:_\-\.]+$/.test(value)) return null
  return value
}

function parseSignatureHex(value: string | null): Uint8Array | null {
  if (!value) return null
  if (!value.startsWith(SIGNATURE_PREFIX)) return null
  return fromHex(value.slice(SIGNATURE_PREFIX.length))
}

function isTimestampAcceptable(args: {
  timestampSeconds: number
  nowSeconds: number
  maxAgeSeconds: number
  maxFutureSkewSeconds: number
}): boolean {
  const age = args.nowSeconds - args.timestampSeconds
  if (age > args.maxAgeSeconds) return false
  if (age < -args.maxFutureSkewSeconds) return false
  return true
}

export async function verifySignedRequest(
  req: Request,
  options: SignedRequestVerifyOptions,
): Promise<
  | { ok: true; verified: VerifiedSignedRequest }
  | { ok: false; denied: Response }
> {
  const deny = (status: number, code: string) => ({
    ok: false as const,
    denied: new Response(
      JSON.stringify({ success: false, error: code }),
      { status, headers: { 'Content-Type': 'application/json' } },
    ),
  })

  if (!options.signingKey) return deny(503, 'Service unavailable')

  const requestId = parseRequestId(req.headers.get('x-request-id'))
  if (!requestId) return deny(401, 'Unauthorized')

  const timestampHeader = req.headers.get('x-timestamp')
  if (timestampHeader === null) {
    return deny(401, 'Unauthorized')
  }
  const timestampSeconds = parseTimestampSeconds(timestampHeader)
  if (!timestampSeconds) return deny(401, 'Unauthorized')

  const providedSig = parseSignatureHex(req.headers.get('x-signature'))
  if (!providedSig) return deny(401, 'Unauthorized')

  const expectedMethod = (options.expectedMethod ?? 'POST').toUpperCase()
  const url = new URL(req.url)
  const runtimePathAndQuery = url.pathname + url.search
  if (
    req.method.toUpperCase() !== expectedMethod ||
    runtimePathAndQuery !==
      (options.expectedRuntimePathAndQuery ?? options.expectedPathAndQuery)
  ) {
    return deny(401, 'Unauthorized')
  }

  const nowSeconds =
    options.nowSeconds ?? Math.floor(Date.now() / 1000)

  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS
  const maxFutureSkewSeconds =
    options.maxFutureSkewSeconds ?? DEFAULT_MAX_FUTURE_SKEW_SECONDS

  if (
    !isTimestampAcceptable({
      timestampSeconds,
      nowSeconds,
      maxAgeSeconds,
      maxFutureSkewSeconds,
    })
  ) {
    return deny(401, 'Unauthorized')
  }

  const bodyText = await req.text()
  const bodySha256Hex = await sha256Hex(bodyText)

  const canonical = buildCanonicalString({
    timestampSeconds,
    requestId,
    method: req.method,
    pathAndQuery: options.expectedPathAndQuery,
    bodySha256Hex,
  })
  const expectedHex = await hmacSha256Hex(options.signingKey, canonical)
  const expectedBytes = fromHex(expectedHex)
  if (!expectedBytes) return deny(401, 'Unauthorized')

  if (!constantTimeEqual(providedSig, expectedBytes)) {
    return deny(401, 'Unauthorized')
  }

  return {
    ok: true,
    verified: {
      requestId,
      timestampSeconds,
      bodyText,
      bodySha256Hex,
    },
  }
}

export async function signRequest(args: {
  signingKey: string
  requestId: string
  timestampSeconds: number
  method: string
  pathAndQuery: string
  bodyText: string
}): Promise<{ headers: Record<string, string>; bodySha256Hex: string }> {
  const bodySha256Hex = await sha256Hex(args.bodyText)
  const canonical = buildCanonicalString({
    timestampSeconds: args.timestampSeconds,
    requestId: args.requestId,
    method: args.method,
    pathAndQuery: args.pathAndQuery,
    bodySha256Hex,
  })
  const signatureHex = await hmacSha256Hex(args.signingKey, canonical)

  return {
    bodySha256Hex,
    headers: {
      'x-request-id': args.requestId,
      'x-timestamp': String(args.timestampSeconds),
      'x-signature': `${SIGNATURE_PREFIX}${signatureHex}`,
    },
  }
}
