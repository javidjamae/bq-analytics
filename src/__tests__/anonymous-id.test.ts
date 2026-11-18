import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { isAnonymousId, readAnonymousId } from '../anonymous-id.js'

const ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b'

function withCookie(cookie?: string): Request {
  return new Request('https://example.test/signup', {
    method: 'POST',
    headers: cookie === undefined ? {} : { cookie },
  })
}

test('reads the tracker id from among other cookies', () => {
  assert.equal(readAnonymousId(withCookie(`session=xyz; ba_anonymous_id=${ID}; theme=dark`)), ID)
  assert.equal(readAnonymousId(withCookie(`ba_anonymous_id=${ID}`)), ID)
})

test('accepts the fallback id a browser without crypto.randomUUID mints', () => {
  assert.equal(readAnonymousId(withCookie('ba_anonymous_id=18c2f3a4b5d-9e8f7a6b')), '18c2f3a4b5d-9e8f7a6b')
})

test('absent: no cookie header, or no tracker cookie in it', () => {
  assert.equal(readAnonymousId(withCookie()), null)
  assert.equal(readAnonymousId(withCookie('session=xyz; theme=dark')), null)
  // A different cookie whose name merely ends with ours is not ours.
  assert.equal(readAnonymousId(withCookie(`x_ba_anonymous_id=${ID}`)), null)
})

test('malformed: anything the tracker could not have minted is null', () => {
  for (const value of [
    '',
    'not-an-id',
    `${ID}x`,
    ID.toUpperCase(),
    "' OR 1=1 --",
    '%3Cscript%3E',
    'a'.repeat(400),
  ]) {
    assert.equal(readAnonymousId(withCookie(`ba_anonymous_id=${value}`)), null, value)
  }
})

test('isAnonymousId matches what the tracker mints and nothing else', () => {
  assert.equal(isAnonymousId(ID), true)
  assert.equal(isAnonymousId(crypto.randomUUID()), true)
  assert.equal(isAnonymousId(undefined), false)
  assert.equal(isAnonymousId(42), false)
})
