import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/marketing')
const base = process.argv[2]
const canonical = 'https://claudeshare.space'
const plain = (s) => s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/\s+/g,' ').trim()
const read = async (path, agent) => {
  if (!base) return readFileSync(resolve(root, path === '/' ? 'index.html' : path === '/guide/' ? 'guide/index.html' : path.slice(1)), 'utf8')
  const r = await fetch(new URL(path, base), { headers: { 'user-agent': agent || 'ClaudeShare-SEO-Check' }, redirect: 'manual', signal: AbortSignal.timeout(15000) })
  assert.equal(r.status, 200, path)
  assert.ok(!r.headers.get('x-robots-tag')?.includes('noindex'), path)
  if (path.endsWith('.txt')) assert.match(r.headers.get('content-type'), /text\/plain/, path)
  if (path.endsWith('.xml')) assert.match(r.headers.get('content-type'), /xml/, path)
  return r.text()
}
for (const path of ['/', '/guide/']) {
  const html = await read(path)
  assert.equal([...html.matchAll(/<h1\b/g)].length, 1, path)
  assert.match(plain(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)[1]), /Claude Code/)
  const title = html.match(/<title>([^<]+)<\/title>/)[1]
  assert.ok(title.includes('Claude Share') && title.length <= 65, title)
  const description = html.match(/name="description"\s+content="([^"]+)"/)[1]
  assert.ok(description.length >= 90 && description.length <= 170, description)
  assert.ok(html.includes(`rel="canonical" href="${canonical}${path}"`))
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
  assert.equal(scripts.length, 1)
  const data = JSON.parse(scripts[0][1])
  assert.equal(data['@context'], 'https://schema.org')
  assert.ok(data['@graph'].length >= 2)
  const visible = plain(html)
  for (const entity of data['@graph']) {
    assert.ok(!entity.aggregateRating, 'Do not invent review ratings')
    if (entity['@type'] === 'FAQPage') for (const faq of entity.mainEntity) {
      assert.ok(visible.includes(faq.name), `FAQ question must be visible: ${faq.name}`)
      assert.ok(visible.includes(faq.acceptedAnswer.text), `FAQ answer must match visible text: ${faq.name}`)
    }
  }
  assert.match(visible, /Secure billing through Monri/)
  assert.match(visible, /teka\.management/)
  assert.doesNotMatch(visible, /billing is currently in test mode|use Monri test cards only/i)
  assert.match(html, /href="\/login"/)
  console.log(`PASS ${path}: static content, metadata, canonical, structured data`)
}
const robots = await read('/robots.txt')
const sitemap = await read('/sitemap.xml')
for (const bot of ['OAI-SearchBot', 'ChatGPT-User', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot']) {
  assert.ok(robots.includes(`User-agent: ${bot}`))
  if (base) assert.match(await read('/', bot), /Claude Code/)
}
assert.match(robots, /Allow: \/\n/)
assert.ok(!/^Disallow: \/\s*$/m.test(robots))
for (const path of ['/api/', '/auth/', '/sessions/', '/board', '/workspace']) assert.ok(robots.includes(`Disallow: ${path}`))
assert.ok(robots.includes(`Sitemap: ${canonical}/sitemap.xml`))
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(x => x[1])
assert.deepEqual(urls, [`${canonical}/`, `${canonical}/guide/`])
assert.match(await read('/llms.txt'), /Jira, Slack, and Linear are in development/)
const keyFile = readdirSync(root).find(name => /^[a-f0-9]{32}\.txt$/.test(name))
assert.ok(keyFile)
assert.equal((await read(`/${keyFile}`)).trim(), keyFile.slice(0,-4))
if (base) {
  for (const path of ['/login', '/account', '/api/cloud/account', '/workspace', '/board']) {
    const r = await fetch(new URL(path, base), { redirect: 'manual' })
    assert.match(r.headers.get('x-robots-tag'), /noindex/, path)
  }
  for (const path of ['/unknown-seo-check', '/assets/unknown-seo-check.png']) {
    const r = await fetch(new URL(path, base))
    assert.equal(r.status, 404, path)
  }
  const www = new URL(base); www.hostname = 'www.' + www.hostname
  const r = await fetch(www, { redirect: 'manual' })
  assert.equal(r.status, 308)
  assert.equal(r.headers.get('location'), canonical + '/')
}
console.log('PASS sitemap, search crawler access, private-route exclusion, product reference, IndexNow key' + (base ? ', deployed redirects and 404s' : ''))
