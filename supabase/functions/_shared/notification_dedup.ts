export type NotificationSource =
  | 'notify-defect'
  | 'notify-expiring-invites'

type RpcResponse = {
  data: unknown
  error: unknown
}

export type NotificationRpcClient = {
  rpc: (
    functionName: string,
    args: Record<string, unknown>,
  ) => PromiseLike<RpcResponse>
}

export type NotificationRunResult<T> =
  | { kind: 'completed'; value: T }
  | { kind: 'duplicate' }
  | { kind: 'database-error'; error: unknown; recoveryError?: unknown }
  | { kind: 'processing-error'; error: unknown; recoveryError?: unknown }

async function callRpc(
  client: NotificationRpcClient,
  functionName: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; data: unknown } | { ok: false; error: unknown }> {
  try {
    const result = await client.rpc(functionName, args)
    if (result.error) return { ok: false, error: result.error }
    return { ok: true, data: result.data }
  } catch (error) {
    return { ok: false, error }
  }
}

async function releaseClaim(
  client: NotificationRpcClient,
  source: NotificationSource,
  requestId: string,
  claimToken: string,
): Promise<unknown | null> {
  const release = await callRpc(client, 'fail_notification_request', {
    p_source: source,
    p_request_id: requestId,
    p_claim_token: claimToken,
  })

  if (release.ok && release.data === true) return null
  return release.ok ? new Error('Claim release failed') : release.error
}

export async function runNotificationOnce<T>(
  client: NotificationRpcClient,
  source: NotificationSource,
  requestId: string,
  process: () => Promise<T>,
): Promise<NotificationRunResult<T>> {
  const claim = await callRpc(client, 'claim_notification_request', {
    p_source: source,
    p_request_id: requestId,
  })
  if (!claim.ok) return { kind: 'database-error', error: claim.error }
  if (claim.data === null) return { kind: 'duplicate' }
  if (typeof claim.data !== 'string' || claim.data.length === 0) {
    return {
      kind: 'database-error',
      error: new Error('Invalid notification claim response'),
    }
  }

  const claimToken = claim.data
  let value: T
  try {
    value = await process()
  } catch (error) {
    const recoveryError = await releaseClaim(
      client,
      source,
      requestId,
      claimToken,
    )
    return {
      kind: 'processing-error',
      error,
      ...(recoveryError ? { recoveryError } : {}),
    }
  }

  const complete = await callRpc(client, 'complete_notification_request', {
    p_source: source,
    p_request_id: requestId,
    p_claim_token: claimToken,
  })
  if (complete.ok && complete.data === true) {
    return { kind: 'completed', value }
  }

  const recoveryError = await releaseClaim(
    client,
    source,
    requestId,
    claimToken,
  )
  return {
    kind: 'database-error',
    error: complete.ok ? new Error('Claim completion failed') : complete.error,
    ...(recoveryError ? { recoveryError } : {}),
  }
}
