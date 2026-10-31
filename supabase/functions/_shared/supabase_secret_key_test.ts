import { getDefaultSecretKey } from './supabase_secret_key.ts'

Deno.test('default secret key: selects only the default key', () => {
  const key = getDefaultSecretKey(
    JSON.stringify({ default: 'server-key', secondary: 'other-key' }),
  )

  if (key !== 'server-key') {
    throw new Error('must select the default secret API key')
  }
})

Deno.test('default secret key: rejects missing or malformed configuration', () => {
  const invalidConfigurations = [
    undefined,
    'not-json',
    JSON.stringify([]),
    JSON.stringify({ secondary: 'other-key' }),
    JSON.stringify({ default: '' }),
    JSON.stringify({ default: 42 }),
  ]

  for (const configuration of invalidConfigurations) {
    let message = ''
    try {
      getDefaultSecretKey(configuration)
    } catch (error) {
      if (error instanceof Error) message = error.message
    }

    if (!message) {
      throw new Error('invalid secret-key configuration must fail')
    }
    if (message.includes('other-key') || message.includes('server-key')) {
      throw new Error('configuration errors must not expose key values')
    }
  }
})
