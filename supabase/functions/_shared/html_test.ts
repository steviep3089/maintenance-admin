import { escapeHtml } from './html.ts'

Deno.test('HTML escaping protects user-controlled email content', () => {
  const escaped = escapeHtml(`<img src=x onerror="alert('x')">&`)
  if (escaped !== '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;') {
    throw new Error('HTML metacharacters must be escaped')
  }
})
