import { getDefaultSecretKey } from './notification_secret_key.ts'

Deno.test('admin client key: selects only default secret key', () => {
  const secretKey = getDefaultSecretKey(
    JSON.stringify({ default: 'testing-secret', secondary: 'other-secret' }),
  )

  if (secretKey !== 'testing-secret') {
    throw new Error('must select the default secret API key')
  }
})

Deno.test('admin client key: missing and malformed configuration fails safely', () => {
  const invalidConfigurations = [
    undefined,
    'not-json',
    JSON.stringify([]),
    JSON.stringify({ named: 'other-secret' }),
    JSON.stringify({ default: '' }),
    JSON.stringify({ default: 42 }),
  ]

  for (const configuration of invalidConfigurations) {
    let errorMessage = ''
    try {
      getDefaultSecretKey(configuration)
    } catch (error) {
      if (error instanceof Error) errorMessage = error.message
    }

    if (!errorMessage) {
      throw new Error('invalid secret-key configuration must fail')
    }
    if (errorMessage.includes('other-secret')) {
      throw new Error('configuration errors must not expose key values')
    }
  }
})
