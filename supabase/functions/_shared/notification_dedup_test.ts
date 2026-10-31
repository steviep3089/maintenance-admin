import { runNotificationOnce, type NotificationRpcClient } from './notification_dedup.ts'

function createRpcClient(
  responses: Array<{ data: unknown; error: unknown }>,
  calls: string[],
): NotificationRpcClient {
  return {
    rpc(functionName) {
      calls.push(functionName)
      const response = responses.shift()
      if (!response) throw new Error('Unexpected RPC call')
      return Promise.resolve(response)
    },
  }
}

Deno.test('notification claim: duplicate request does not process', async () => {
  const calls: string[] = []
  let processed = false
  const result = await runNotificationOnce(
    createRpcClient([{ data: null, error: null }], calls),
    'notify-defect',
    'defect:1',
    async () => {
      processed = true
    },
  )

  if (result.kind !== 'duplicate' || processed) {
    throw new Error('duplicate request must not run processing')
  }
  if (calls.join(',') !== 'claim_notification_request') {
    throw new Error('duplicate request must only attempt the atomic claim')
  }
})

Deno.test('notification claim: database errors are not duplicates', async () => {
  const calls: string[] = []
  const databaseError = { code: '42501' }
  const result = await runNotificationOnce(
    createRpcClient([{ data: null, error: databaseError }], calls),
    'notify-defect',
    'defect:db-error',
    async () => {
      throw new Error('processing must not run')
    },
  )

  if (result.kind !== 'database-error' || result.error !== databaseError) {
    throw new Error('database errors must be returned as errors')
  }
})

Deno.test('notification claim: unexpected claim responses are errors', async () => {
  const result = await runNotificationOnce(
    createRpcClient([{ data: { id: 'unexpected' }, error: null }], []),
    'notify-expiring-invites',
    'digest:unexpected-claim',
    async () => undefined,
  )

  if (result.kind !== 'database-error') {
    throw new Error('unexpected claim response must remain a database error')
  }
})

Deno.test('notification claim: failed processing releases claim for retry', async () => {
  const calls: string[] = []
  const processingError = new Error('simulated email failure')
  const result = await runNotificationOnce(
    createRpcClient(
      [
        { data: 'claim-token-1', error: null },
        { data: true, error: null },
      ],
      calls,
    ),
    'notify-defect',
    'defect:retry',
    async () => {
      throw processingError
    },
  )

  if (result.kind !== 'processing-error' || result.error !== processingError) {
    throw new Error('processing failure must be returned')
  }
  if (calls.join(',') !== 'claim_notification_request,fail_notification_request') {
    throw new Error('failed processing must release its claim')
  }
})

Deno.test('notification claim: successful processing completes the claim', async () => {
  const calls: string[] = []
  const result = await runNotificationOnce(
    createRpcClient(
      [
        { data: 'claim-token-2', error: null },
        { data: true, error: null },
      ],
      calls,
    ),
    'notify-expiring-invites',
    'daily-user-digest:20261029',
    async () => 'sent',
  )

  if (result.kind !== 'completed' || result.value !== 'sent') {
    throw new Error('successful processing must complete the claim')
  }
  if (calls.join(',') !== 'claim_notification_request,complete_notification_request') {
    throw new Error('successful processing must complete exactly once')
  }
})

Deno.test('notification claim: completion database errors remain visible', async () => {
  const calls: string[] = []
  const completionError = { code: '08006' }
  const recoveryError = { code: '08006' }
  const result = await runNotificationOnce(
    createRpcClient(
      [
        { data: 'claim-token-3', error: null },
        { data: null, error: completionError },
        { data: null, error: recoveryError },
      ],
      calls,
    ),
    'notify-expiring-invites',
    'daily-user-digest:db-error',
    async () => 'sent',
  )

  if (result.kind !== 'database-error' || result.error !== completionError) {
    throw new Error('completion database error must not be reported as success')
  }
  if (result.kind !== 'database-error' || result.recoveryError !== recoveryError) {
    throw new Error('completion and recovery RPC errors must remain visible')
  }
  if (!calls.includes('fail_notification_request')) {
    throw new Error('failed completion must attempt to release the claim')
  }
})

Deno.test('notification claim: unexpected completion results remain errors', async () => {
  const result = await runNotificationOnce(
    createRpcClient(
      [
        { data: 'claim-token-5', error: null },
        { data: false, error: null },
        { data: true, error: null },
      ],
      [],
    ),
    'notify-expiring-invites',
    'daily-user-digest:unexpected-completion',
    async () => 'sent',
  )

  if (result.kind !== 'database-error') {
    throw new Error('unexpected completion result must remain a database error')
  }
})

Deno.test('notification claim: failed release remains visible', async () => {
  const recoveryError = { code: '08006' }
  const result = await runNotificationOnce(
    createRpcClient(
      [
        { data: 'claim-token-4', error: null },
        { data: null, error: recoveryError },
      ],
      [],
    ),
    'notify-defect',
    'defect:release-error',
    async () => {
      throw new Error('processing failed')
    },
  )

  if (result.kind !== 'processing-error' || result.recoveryError !== recoveryError) {
    throw new Error('claim release failure must remain visible for retry handling')
  }
})
