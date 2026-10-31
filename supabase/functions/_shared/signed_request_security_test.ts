import { signRequest, verifySignedRequest } from './signed_request.ts'

const signingKey = 'offline-test-signing-key'
const pathAndQuery = '/functions/v1/notify-defect'
const nowSeconds = 1_800_000_000
const bodyText = '{"value":"exact body"}'

async function verify(
  headers: Record<string, string>,
  options: { method?: string; url?: string; body?: string } = {},
) {
  return await verifySignedRequest(
    new Request(`https://example.invalid${options.url ?? pathAndQuery}`, {
      method: options.method ?? 'POST',
      headers,
      body: options.method === 'GET' ? undefined : options.body ?? bodyText,
    }),
    { signingKey, expectedPathAndQuery: pathAndQuery, nowSeconds },
  )
}

async function signedHeaders(
  requestId: string,
  timestampSeconds = nowSeconds,
  method = 'POST',
) {
  const signed = await signRequest({
    signingKey,
    requestId,
    timestampSeconds,
    method,
    pathAndQuery,
    bodyText,
  })
  return signed.headers
}

Deno.test('signed request: valid signature verifies exact request body', async () => {
  const result = await verify(await signedHeaders('test:valid'))
  if (!result.ok || result.verified.bodyText !== bodyText) {
    throw new Error('valid signature and exact request body should verify')
  }
})

Deno.test('signed request: body tampering is rejected', async () => {
  const result = await verify(await signedHeaders('test:tamper'), {
    body: '{"value":"changed"}',
  })
  if (result.ok || result.denied.status !== 401) {
    throw new Error('tampered body should return 401')
  }
})

Deno.test('signed request: expired and future timestamps are rejected', async () => {
  const expired = await verify(await signedHeaders('test:expired', nowSeconds - 301))
  const future = await verify(await signedHeaders('test:future', nowSeconds + 31))
  if (expired.ok || expired.denied.status !== 401) {
    throw new Error('expired signature should return 401')
  }
  if (future.ok || future.denied.status !== 401) {
    throw new Error('future-dated signature should return 401')
  }
})

Deno.test('signed request: method and path tampering are rejected', async () => {
  const methodHeaders = await signedHeaders('test:method', nowSeconds, 'GET')
  const wrongMethod = await verify(methodHeaders, { method: 'GET' })
  const pathHeaders = await signedHeaders('test:path')
  const wrongPath = await verify(pathHeaders, { url: `${pathAndQuery}?unexpected=1` })

  if (
    wrongMethod.ok ||
    wrongMethod.denied.status !== 401
  ) {
    throw new Error('unexpected method should return 401')
  }
  if (
    wrongPath.ok ||
    wrongPath.denied.status !== 401
  ) {
    throw new Error('unexpected path/query should return 401')
  }
})

Deno.test('signed request: confirmed runtime path verifies the public signed path', async () => {
  const runtimePath = '/notify-expiring-invites'
  const signedPath = '/functions/v1/notify-expiring-invites'
  const body = '{"dryRun":true,"allowDeactivation":false}'
  const headers = await signRequest({
    signingKey,
    requestId: 'test:confirmed-runtime-path',
    timestampSeconds: nowSeconds,
    method: 'POST',
    pathAndQuery: signedPath,
    bodyText: body,
  })
  const result = await verifySignedRequest(
    new Request(`https://example.invalid${runtimePath}`, {
      method: 'POST',
      headers: headers.headers,
      body,
    }),
    {
      signingKey,
      expectedPathAndQuery: signedPath,
      expectedRuntimePathAndQuery: runtimePath,
      nowSeconds,
    },
  )

  if (!result.ok || result.verified.bodyText !== body) {
    throw new Error('confirmed runtime path should verify the public signed path')
  }
})

Deno.test('signed request: invalid function runtime paths remain unauthorized', async () => {
  const invalidPaths = [
    '/',
    '/functions/v1/notify-expiring-invites',
    '/other',
    '/notify-expiring-invites/',
    '/notify-expiring-invites?extra=1',
  ]
  const signedPath = '/functions/v1/notify-expiring-invites'
  const body = '{"dryRun":true,"allowDeactivation":false}'
  const headers = await signRequest({
    signingKey,
    requestId: 'test:runtime-invalid-paths',
    timestampSeconds: nowSeconds,
    method: 'POST',
    pathAndQuery: signedPath,
    bodyText: body,
  })

  for (const runtimePath of invalidPaths) {
    const result = await verifySignedRequest(
      new Request(`https://example.invalid${runtimePath}`, {
        method: 'POST',
        headers: headers.headers,
        body,
      }),
      {
        signingKey,
        expectedPathAndQuery: signedPath,
        expectedRuntimePathAndQuery: '/notify-expiring-invites',
        nowSeconds,
      },
    )
    if (
      result.ok ||
      result.denied.status !== 401
    ) {
      throw new Error(`invalid runtime path should return 401`)
    }
  }

  const wrongMethod = await verifySignedRequest(
    new Request('https://example.invalid/notify-expiring-invites', {
      method: 'GET',
      headers: headers.headers,
    }),
    {
      signingKey,
      expectedPathAndQuery: signedPath,
      expectedRuntimePathAndQuery: '/notify-expiring-invites',
      nowSeconds,
    },
  )
  if (
    wrongMethod.ok ||
    wrongMethod.denied.status !== 401
  ) {
    throw new Error('notify-expiring-invites must reject non-POST methods')
  }
})

Deno.test('signed request: notify-defect runtime path uses its public canonical path', async () => {
  const runtimePath = '/notify-defect'
  const signedPath = '/functions/v1/notify-defect'
  const body = '{"dryRun":true,"id":"00000000-0000-0000-0000-000000000000"}'
  const headers = await signRequest({
    signingKey,
    requestId: 'test:defect-runtime-path',
    timestampSeconds: nowSeconds,
    method: 'POST',
    pathAndQuery: signedPath,
    bodyText: body,
  })

  const result = await verifySignedRequest(
    new Request(`https://example.invalid${runtimePath}`, {
      method: 'POST',
      headers: headers.headers,
      body,
    }),
    {
      signingKey,
      expectedPathAndQuery: signedPath,
      expectedRuntimePathAndQuery: runtimePath,
      nowSeconds,
    },
  )

  if (!result.ok || result.verified.bodyText !== body) {
    throw new Error('notify-defect runtime path should verify using its public canonical path')
  }
})

Deno.test('signed request: notify-defect rejects invalid runtime paths and query strings', async () => {
  const signedPath = '/functions/v1/notify-defect'
  const body = '{"dryRun":true,"id":"00000000-0000-0000-0000-000000000000"}'
  const headers = await signRequest({
    signingKey,
    requestId: 'test:defect-invalid-runtime-path',
    timestampSeconds: nowSeconds,
    method: 'POST',
    pathAndQuery: signedPath,
    bodyText: body,
  })

  for (const runtimePath of [
    '/',
    signedPath,
    '/other',
    '/notify-defect/',
    '/notify-defect?extra=1',
  ]) {
    const result = await verifySignedRequest(
      new Request(`https://example.invalid${runtimePath}`, {
        method: 'POST',
        headers: headers.headers,
        body,
      }),
      {
        signingKey,
        expectedPathAndQuery: signedPath,
        expectedRuntimePathAndQuery: '/notify-defect',
        nowSeconds,
      },
    )

    if (
      result.ok ||
      result.denied.status !== 401
    ) {
      throw new Error('invalid notify-defect runtime path should remain unauthorized')
    }
  }

  const wrongMethod = await verifySignedRequest(
    new Request('https://example.invalid/notify-defect', {
      method: 'GET',
      headers: headers.headers,
    }),
    {
      signingKey,
      expectedPathAndQuery: signedPath,
      expectedRuntimePathAndQuery: '/notify-defect',
      nowSeconds,
    },
  )
  if (
    wrongMethod.ok ||
    wrongMethod.denied.status !== 401
  ) {
    throw new Error('notify-defect must reject non-POST methods')
  }
})

Deno.test('signed request: missing and malformed signatures are rejected', async () => {
  const valid = await signedHeaders('test:invalid-signatures')
  const missing = { ...valid }
  delete missing['x-signature']
  const malformed = { ...valid, 'x-signature': 'v1=0g'.padEnd(67, '0') }

  const missingResult = await verify(missing)
  const malformedResult = await verify(malformed)
  if (missingResult.ok || missingResult.denied.status !== 401) {
    throw new Error('missing signature should return 401')
  }
  if (malformedResult.ok || malformedResult.denied.status !== 401) {
    throw new Error('malformed signature should return 401')
  }
})

Deno.test('signed request: missing request identifiers and invalid timestamps are rejected', async () => {
  const valid = await signedHeaders('test:invalid-timestamp')
  const missingRequestId = { ...valid }
  delete missingRequestId['x-request-id']
  const missingTimestamp = { ...valid }
  delete missingTimestamp['x-timestamp']
  const invalidTimestamp = { ...valid, 'x-timestamp': 'not-a-timestamp' }

  for (const headers of [missingRequestId, missingTimestamp, invalidTimestamp]) {
    const result = await verify(headers)
    if (result.ok || result.denied.status !== 401) {
      throw new Error('missing or invalid signing headers should return 401')
    }
  }
})

Deno.test('signed request: signature mismatch remains unauthorized', async () => {
  const headers = await signedHeaders('test:signature-mismatch')
  headers['x-signature'] = `v1=${'0'.repeat(64)}`
  const result = await verify(headers)
  if (result.ok || result.denied.status !== 401) {
    throw new Error('invalid HMAC should return 401')
  }
})

Deno.test('signed request: unsigned dry-run header is not part of body verification', async () => {
  const headers = await signedHeaders('test:dry-run-header')
  headers['x-dry-run'] = '1'
  const result = await verify(headers)
  if (!result.ok || result.verified.bodyText !== bodyText) {
    throw new Error('unsigned dry-run header must not affect signature verification')
  }
})
