import { signRequest, verifySignedRequest } from './signed_request.ts'

Deno.test('signed request: valid signature verifies', async () => {
  const signingKey = 'test-signing-key'
  const pathAndQuery = '/functions/v1/notify-defect'
  const bodyText = JSON.stringify({ hello: 'world' })
  const nowSeconds = Math.floor(Date.now() / 1000)

  const { headers } = await signRequest({
    signingKey,
    requestId: 'test:1',
    timestampSeconds: nowSeconds,
    method: 'POST',
    pathAndQuery,
    bodyText,
  })

  const req = new Request(`https://example.invalid${pathAndQuery}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: bodyText,
  })

  const result = await verifySignedRequest(req, {
    signingKey,
    expectedPathAndQuery: pathAndQuery,
    nowSeconds,
  })

  if (!result.ok) throw new Error('expected ok=true')
  if (result.verified.requestId !== 'test:1') throw new Error('wrong requestId')
})

Deno.test('signed request: modified body fails', async () => {
  const signingKey = 'test-signing-key'
  const pathAndQuery = '/functions/v1/notify-defect'
  const bodyText = JSON.stringify({ hello: 'world' })
  const nowSeconds = Math.floor(Date.now() / 1000)

  const { headers } = await signRequest({
    signingKey,
    requestId: 'test:2',
    timestampSeconds: nowSeconds,
    method: 'POST',
    pathAndQuery,
    bodyText,
  })

  const req = new Request(`https://example.invalid${pathAndQuery}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ hello: 'tampered' }),
  })

  const result = await verifySignedRequest(req, {
    signingKey,
    expectedPathAndQuery: pathAndQuery,
    nowSeconds,
  })

  if (result.ok) throw new Error('expected ok=false')
  if (result.denied.status !== 401) throw new Error('expected 401')
})

Deno.test('signed request: expired timestamp fails', async () => {
  const signingKey = 'test-signing-key'
  const pathAndQuery = '/functions/v1/notify-defect'
  const bodyText = JSON.stringify({ hello: 'world' })
  const nowSeconds = Math.floor(Date.now() / 1000)

  const { headers } = await signRequest({
    signingKey,
    requestId: 'test:3',
    timestampSeconds: nowSeconds - 3600,
    method: 'POST',
    pathAndQuery,
    bodyText,
  })

  const req = new Request(`https://example.invalid${pathAndQuery}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: bodyText,
  })

  const result = await verifySignedRequest(req, {
    signingKey,
    expectedPathAndQuery: pathAndQuery,
    nowSeconds,
    maxAgeSeconds: 300,
  })

  if (result.ok) throw new Error('expected ok=false')
  if (result.denied.status !== 401) throw new Error('expected 401')
})
